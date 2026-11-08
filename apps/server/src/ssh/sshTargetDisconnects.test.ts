import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSshTargetConnected,
  clearSshTargetDisconnected,
  configureSshTargetDisconnects,
  isSshTargetDisconnected,
  listDisconnectedSshTargets,
  markSshTargetDisconnected,
  REMOTE_TARGET_DISCONNECTED_CODE,
  REMOTE_TARGET_DISCONNECTED_MESSAGE,
  RemoteTargetDisconnectedError,
  type SshTargetDisconnectStore,
} from "./sshTargetDisconnects.ts";

const target = "ssh:host=box&auth=ssh-key&transport=agent";

function store(overrides: Partial<SshTargetDisconnectStore> = {}) {
  return {
    persist: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...overrides,
  } satisfies SshTargetDisconnectStore;
}

afterEach(() => configureSshTargetDisconnects(undefined, []));

describe("SSH target disconnect registry", () => {
  it("guards only flagged targets with the typed, user-facing error", async () => {
    await markSshTargetDisconnected(target);
    expect(isSshTargetDisconnected(target)).toBe(true);
    expect(() => assertSshTargetConnected("ssh:host=other")).not.toThrow();
    expect(() => assertSshTargetConnected(undefined)).not.toThrow();
    let thrown: unknown;
    try {
      assertSshTargetConnected(target);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(RemoteTargetDisconnectedError);
    expect(thrown).toMatchObject({
      message: REMOTE_TARGET_DISCONNECTED_MESSAGE,
      code: REMOTE_TARGET_DISCONNECTED_CODE,
      executionTargetId: target,
    });
  });

  it("persists before enforcing, and is idempotent in both directions", async () => {
    const durable = store();
    configureSshTargetDisconnects(durable, []);
    await expect(markSshTargetDisconnected(target)).resolves.toBe(true);
    await expect(markSshTargetDisconnected(target)).resolves.toBe(false);
    expect(durable.persist).toHaveBeenCalledOnce();
    expect(durable.persist).toHaveBeenCalledWith(target, expect.any(Number));
    expect(listDisconnectedSshTargets()).toEqual([target]);

    await expect(clearSshTargetDisconnected(target)).resolves.toBe(true);
    await expect(clearSshTargetDisconnected(target)).resolves.toBe(false);
    expect(durable.remove).toHaveBeenCalledOnce();
    expect(isSshTargetDisconnected(target)).toBe(false);
  });

  it("changes nothing when persistence fails", async () => {
    configureSshTargetDisconnects(
      store({ persist: vi.fn(async () => Promise.reject(new Error("disk full"))) }),
      [],
    );
    await expect(markSshTargetDisconnected(target)).rejects.toThrow("disk full");
    expect(isSshTargetDisconnected(target)).toBe(false);

    configureSshTargetDisconnects(
      store({ remove: vi.fn(async () => Promise.reject(new Error("locked"))) }),
      [target],
    );
    await expect(clearSshTargetDisconnected(target)).rejects.toThrow("locked");
    expect(isSshTargetDisconnected(target)).toBe(true);
  });

  it("serializes a concurrent disconnect and connect so store and memory agree", async () => {
    const persisted = new Set<string>();
    let releasePersist!: () => void;
    const gate = new Promise<void>((resolve) => (releasePersist = resolve));
    configureSshTargetDisconnects(
      store({
        persist: vi.fn(async (id: string) => {
          await gate;
          persisted.add(id);
        }),
        remove: vi.fn(async (id: string) => void persisted.delete(id)),
      }),
      [],
    );
    const disconnect = markSshTargetDisconnected(target);
    const connect = clearSshTargetDisconnected(target);
    releasePersist();
    await Promise.all([disconnect, connect]);
    expect(isSshTargetDisconnected(target)).toBe(persisted.has(target));
    expect(isSshTargetDisconnected(target)).toBe(false);
  });

  it("replaces memory with loaded flags and lists them sorted", () => {
    configureSshTargetDisconnects(store(), ["ssh:host=b", "ssh:host=a"]);
    expect(listDisconnectedSshTargets()).toEqual(["ssh:host=a", "ssh:host=b"]);
    configureSshTargetDisconnects(store(), []);
    expect(listDisconnectedSshTargets()).toEqual([]);
  });
});
