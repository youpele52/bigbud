import { expect, it, vi } from "vitest";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { makeOwnedClient } from "./Client.ts";
import { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { FixtureEvents, deferred } from "./Test.fixtures.ts";
import type { OwnedV2Process } from "./ServerManager.child.ts";
import { v2SharedGeneration } from "./SharedService.registration.ts";

const config = {
  runtimeTargetId: "local",
  sharedService: {
    registrationFile: "/native/service.json",
    storageIdentity: "same-db",
    generation: "registered",
  },
};

it("includes authentication rotation in an opaque transport generation, not storage identity", () => {
  const registration = {
    id: "native",
    pid: 123,
    version: "2.2.5",
    endpoint: { url: "http://127.0.0.1:4000" },
  };
  const first = v2SharedGeneration(registration);
  const rotated = v2SharedGeneration({
    ...registration,
    endpoint: {
      ...registration.endpoint,
      auth: { type: "basic", username: "opencode", password: "synthetic-private" },
    },
  });
  expect(rotated).not.toBe(first);
  expect(rotated).toMatch(/^[a-f0-9]{64}$/);
  expect(rotated).not.toContain("synthetic-private");
});
const bounds = {
  maxProcesses: 4,
  maxOwners: 32,
  maxQueuedEvents: 4,
  maxEventBytes: 1024,
  consumerTimeoutMs: 100,
};
function borrowed() {
  let attached = true;
  const source = new FixtureEvents();
  const process: OwnedV2Process = {
    ownership: "borrowed",
    client: {
      ...makeOwnedClient({ endpoint: "http://127.0.0.1:4000", password: "synthetic" }),
      event: {
        subscribe: (options) => source.subscribe(options?.signal ?? new AbortController().signal),
      },
    },
    isRunning: () => attached,
    hasExited: () => false,
    onDeath: () => () => {},
    close: vi.fn(async () => {
      attached = false;
    }),
  };
  return process;
}

it("shares one borrowed hub across different workspace roots and logically retires without daemon-exit proof", async () => {
  const first = borrowed(),
    second = borrowed();
  const start = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const manager = new OpencodeV2ServerManager({ ...bounds, start });
  const leases = await Promise.all([manager.acquire(config), manager.acquire(config)]);
  expect(start).toHaveBeenCalledTimes(1);
  expect(leases[0]!.hub).toBe(leases[1]!.hub);
  expect(() => leases[0]!.claimExclusive()).toThrow("cannot be exclusively owned");
  await Promise.all(leases.map((lease) => lease.release()));
  expect(first.hasExited?.()).toBe(false);
  const next = await manager.acquire(config);
  expect(next.generation).toBeGreaterThan(leases[0]!.generation);
  await next.release();
  await manager.close();
});

it("borrowed detach and a new manager generation never discharge unknown native mutation settlement", async () => {
  const native = borrowed();
  const manager = new OpencodeV2ServerManager({ ...bounds, start: async () => native });
  const lease = await manager.acquire(config);
  const pending = deferred<void>();
  const mutations = new V2RuntimeMutations();
  await expect(
    mutations.runOwned(
      native,
      "uncertain request",
      () => pending.promise,
      async () => false,
      10,
    ),
  ).rejects.toThrow();
  await lease.release();
  await manager.close();
  expect(native.hasExited?.()).toBe(false);
  expect(() => mutations.assertSafe()).toThrow("quarantined");
  pending.resolve();
  await Promise.resolve();
  expect(() => mutations.assertSafe()).toThrow("quarantined");
});

it("late shared acquisition is detached after close without retaining a phantom owned process", async () => {
  const late = deferred<OwnedV2Process>();
  const manager = new OpencodeV2ServerManager({ ...bounds, start: () => late.promise });
  const acquiring = manager.acquire(config);
  const rejection = expect(acquiring).rejects.toThrow("unavailable");
  const closing = manager.close();
  const process = borrowed();
  late.resolve(process);
  await rejection;
  await closing;
  expect(process.hasExited?.()).toBe(false);
});

it("retires exact borrowed generations while old leases cannot close their replacement", async () => {
  const first = borrowed(),
    second = borrowed();
  const start = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const manager = new OpencodeV2ServerManager({ ...bounds, start });
  const old = await manager.acquire(config);
  await Promise.all([
    manager.retireBorrowedGeneration(config.sharedService),
    manager.retireBorrowedGeneration(config.sharedService),
  ]);
  expect(first.close).toHaveBeenCalledTimes(1);
  const next = await manager.acquire({
    ...config,
    sharedService: { ...config.sharedService, generation: "upgraded" },
  });
  await old.release();
  expect(second.close).not.toHaveBeenCalled();
  expect(next.process.isRunning()).toBe(true);
  await manager.retireBorrowedGeneration(config.sharedService);
  expect(next.process.isRunning()).toBe(true);
  await next.release();
  await manager.close();
});

it("retired late startup cannot publish a lease or close a replacement", async () => {
  const pending = deferred<OwnedV2Process>();
  const old = borrowed(),
    next = borrowed();
  const start = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce(next);
  const manager = new OpencodeV2ServerManager({ ...bounds, start });
  const acquiring = manager.acquire(config);
  const rejected = expect(acquiring).rejects.toThrow("unavailable");
  const retiring = manager.retireBorrowedGeneration(config.sharedService);
  const replacement = await manager.acquire({
    ...config,
    sharedService: { ...config.sharedService, generation: "upgraded" },
  });
  pending.resolve(old);
  await Promise.all([rejected, retiring]);
  expect(old.close).toHaveBeenCalledTimes(1);
  expect(next.close).not.toHaveBeenCalled();
  await replacement.release();
  await manager.close();
});
