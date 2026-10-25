import { expect, it, vi } from "vitest";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import type { OwnedV2Process } from "./ServerManager.child.ts";
import { V2UnconfirmedProcessStartup } from "./ServerManager.lifecycle.ts";
import { makeOwnedClient } from "./Client.ts";
import { FixtureEvents } from "./Test.fixtures.ts";

const bounds = {
  maxProcesses: 4,
  maxOwners: 25,
  maxQueuedEvents: 4,
  maxEventBytes: 1024,
  consumerTimeoutMs: 100,
};
const config = {
  runtimeTargetId: "ssh:fixture",
  binaryPath: "/native/v2",
  profileRoot: "/owned/profile",
};
function uncertainProcess() {
  const source = new FixtureEvents(),
    deaths = new Set<() => void>(),
    losses = new Set<() => void>();
  let available = true,
    exited = false;
  const process: OwnedV2Process = {
    client: {
      ...makeOwnedClient({ endpoint: "http://127.0.0.1:4000", password: "synthetic" }),
      event: {
        subscribe: (options) => source.subscribe(options?.signal ?? new AbortController().signal),
      },
    },
    isRunning: () => available && !exited,
    hasExited: () => exited,
    onDeath: (listener) => {
      deaths.add(listener);
      return () => {
        deaths.delete(listener);
      };
    },
    onUnavailable: (listener) => {
      losses.add(listener);
      return () => {
        losses.delete(listener);
      };
    },
    close: vi.fn(async () => {
      available = false;
      if (!exited) throw new Error("close unconfirmed");
    }),
  };
  return {
    process,
    loss: () => {
      available = false;
      for (const listener of losses) listener();
    },
    exit: () => {
      exited = true;
      for (const listener of deaths) listener();
    },
  };
}

it("tunnel-only loss retains exact generation/profile, blocks replacement and leaves other targets usable until exit proof", async () => {
  const first = uncertainProcess(),
    second = uncertainProcess();
  const start = vi.fn().mockResolvedValueOnce(first.process).mockResolvedValue(second.process);
  const manager = new OpencodeV2ServerManager({ ...bounds, start });
  try {
    const lease = await manager.acquire(config);
    first.loss();
    await expect(manager.acquire(config)).rejects.toThrow("closing");
    await expect(manager.acquire({ ...config, binaryPath: "/different/v2" })).rejects.toThrow(
      "storage is already owned",
    );
    expect(start).toHaveBeenCalledTimes(1);
    await expect(lease.release()).rejects.toThrow("close unconfirmed");
    await expect(manager.acquire(config)).rejects.toThrow("closing");
    const sibling = await manager.acquire({ ...config, runtimeTargetId: "ssh:other" });
    expect(sibling.process).toBe(second.process);
    first.exit();
    const replacement = await manager.acquire(config);
    expect(replacement.generation).toBeGreaterThan(lease.generation);
    second.exit();
    await sibling.release();
    await replacement.release();
  } finally {
    await manager.close();
  }
});

it("startup rejection after native readiness retains uncertain storage and releases only on late exact exit", async () => {
  const first = uncertainProcess(),
    second = uncertainProcess();
  const start = vi
    .fn()
    .mockRejectedValueOnce(
      new V2UnconfirmedProcessStartup(first.process, new Error("endpoint failed after readiness")),
    )
    .mockResolvedValueOnce(second.process);
  const manager = new OpencodeV2ServerManager({ ...bounds, start });
  try {
    await expect(manager.acquire(config)).rejects.toThrow("acquisition failed");
    await expect(manager.acquire(config)).rejects.toThrow("closing");
    await expect(manager.acquire({ ...config, workspaceRoot: "/other-root" })).rejects.toThrow(
      "storage is already owned",
    );
    expect(start).toHaveBeenCalledTimes(1);
    first.exit();
    const lease = await manager.acquire(config);
    expect(start).toHaveBeenCalledTimes(2);
    second.exit();
    await lease.release();
  } finally {
    await manager.close();
  }
});

it("manager shutdown is finite but retains an unconfirmed native namespace", async () => {
  const first = uncertainProcess();
  const manager = new OpencodeV2ServerManager({ ...bounds, start: async () => first.process });
  await manager.acquire(config);
  await expect(manager.close()).rejects.toThrow("shutdown remains unconfirmed");
  expect(first.process.hasExited!()).toBe(false);
  expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(1);
  first.exit();
  expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
});
