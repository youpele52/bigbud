import { describe, expect, it, vi } from "vitest";

import { makeOwnedClient } from "./Client.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import type { OwnedV2Process } from "./ServerManager.child.ts";
import { FixtureEvents, deferred, flushMicrotasks } from "./Test.fixtures.ts";

const config = {
  runtimeTargetId: "local",
  binaryPath: "/fixture/v2",
  profileRoot: "/fixture/profile",
};
const bounds = {
  maxProcesses: 4,
  maxOwners: 32,
  maxQueuedEvents: 4,
  maxEventBytes: 1024,
  consumerTimeoutMs: 100,
};

function fakeProcess() {
  const source = new FixtureEvents();
  const listeners = new Set<() => void>();
  let running = true;
  const close = vi.fn(async () => {
    running = false;
  });
  const process: OwnedV2Process = {
    client: {
      ...makeOwnedClient({ endpoint: "http://127.0.0.1:4000", password: "synthetic" }),
      event: {
        subscribe: (options) => source.subscribe(options?.signal ?? new AbortController().signal),
      },
    },
    isRunning: () => running,
    hasExited: () => !running,
    onDeath: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close,
  };
  return {
    process,
    close,
    source,
    die: () => {
      running = false;
      for (const listener of listeners) listener();
    },
  };
}

describe("independent OpenCode v2 process manager", () => {
  it("coalesces 25 leases into one process/client/hub and retains others on release", async () => {
    const fake = fakeProcess();
    const start = vi.fn(async () => fake.process);
    const manager = new OpencodeV2ServerManager({ ...bounds, start });
    const leases = await Promise.all(Array.from({ length: 25 }, () => manager.acquire(config)));
    expect(start).toHaveBeenCalledTimes(1);
    expect(new Set(leases.map((lease) => lease.hub)).size).toBe(1);
    expect(new Set(leases.map((lease) => lease.generation)).size).toBe(1);
    await flushMicrotasks();
    expect(fake.source.subscriptions).toBe(1);
    await leases[0]!.release();
    await leases[0]!.release();
    expect(fake.close).not.toHaveBeenCalled();
    await Promise.all(leases.slice(1).map((lease) => lease.release()));
    expect(fake.close).toHaveBeenCalledTimes(1);
    await manager.close();
  });
  it("fences dead generations without closing a replacement process", async () => {
    const first = fakeProcess();
    const second = fakeProcess();
    const manager = new OpencodeV2ServerManager({
      ...bounds,
      start: vi.fn().mockResolvedValueOnce(first.process).mockResolvedValueOnce(second.process),
    });
    const old = await manager.acquire(config);
    first.die();
    const replacement = await manager.acquire(config);
    expect(replacement.generation).toBeGreaterThan(old.generation);
    await old.release();
    expect(second.close).not.toHaveBeenCalled();
    await replacement.release();
    await manager.close();
  });
  it("disposes late startup after shutdown and rejects further acquisitions", async () => {
    const fake = fakeProcess();
    const started = deferred<OwnedV2Process>();
    const manager = new OpencodeV2ServerManager({ ...bounds, start: () => started.promise });
    const acquiring = manager.acquire(config);
    const rejected = expect(acquiring).rejects.toThrow("generation is unavailable");
    const closing = manager.close();
    started.resolve(fake.process);
    await rejected;
    await closing;
    expect(fake.close).toHaveBeenCalled();
    await expect(manager.acquire(config)).rejects.toThrow("manager is closed");
  });
  it("a failed startup does not poison the next generation", async () => {
    const fake = fakeProcess();
    const manager = new OpencodeV2ServerManager({
      ...bounds,
      start: vi
        .fn()
        .mockRejectedValueOnce(new Error("synthetic failure"))
        .mockResolvedValueOnce(fake.process),
    });
    await expect(manager.acquire(config)).rejects.toThrow("acquisition failed");
    const lease = await manager.acquire(config);
    await lease.release();
    await manager.close();
  });
});
