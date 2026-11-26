import { expect, it, vi } from "vitest";

import { makeSshOwnerDevPicker, SYNTHETIC_SSH_UNLOCK_INTENT } from "./sshOwnerDevPicker.ts";

it.skipIf(process.platform === "linux")(
  "does not invoke an accidentally configured synthetic unlock on a non-Linux owner",
  async () => {
    const startOwner = vi.fn(async () => {
      throw new Error("Unqualified password input must not start an owner");
    });
    const unlock = vi.fn(async () => undefined);
    const executionTargetId = "ssh:disposable-test";
    const picker = makeSshOwnerDevPicker({
      executionTargetId,
      host: "127.0.0.1",
      startOwner,
      unlockSyntheticPasswordFixture: unlock,
    });
    await expect(
      picker.unlockSshPassword({ executionTargetId, password: SYNTHETIC_SSH_UNLOCK_INTENT }),
    ).rejects.toMatchObject({ _tag: "ServerUnlockSshPasswordError" });
    expect(startOwner).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
  },
);

it("rejects credential submissions without waiting behind a busy owner", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const executionTargetId = "ssh:disposable-test";
  const owner = {
    listRemoteFolders: vi.fn(async () => {
      started.resolve();
      await release.promise;
      return { path: "/fixture", homePath: "/fixture", folders: [], truncated: false };
    }),
    listAliases: vi.fn(),
    inspectTrust: vi.fn(),
    approveTrust: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(),
  };
  const unlock = vi.fn(async () => undefined);
  const picker = makeSshOwnerDevPicker({
    executionTargetId,
    host: "127.0.0.1",
    startOwner: async () => owner,
    unlockSyntheticPasswordFixture: unlock,
  });
  const read = picker.listRemoteFolders({ executionTargetId });
  try {
    await started.promise;
    const denied = Promise.allSettled([
      picker.unlockSshPassword({ executionTargetId, password: "synthetic-rejected-password" }),
      picker.unlockSshKey({ executionTargetId, passphrase: "synthetic-rejected-passphrase" }),
    ]);
    // Allow synchronous and promise-based rejection to settle, but never release the owner queue.
    const outcomes = await Promise.race([
      denied,
      new Promise<"queued">((resolve) => setImmediate(() => resolve("queued"))),
    ]);
    expect(outcomes).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({
          _tag: "ServerUnlockSshPasswordError",
          message: "The selected development SSH owner does not accept passwords.",
        }),
      },
      {
        status: "rejected",
        reason: expect.objectContaining({
          _tag: "ServerUnlockSshKeyError",
          message: "The selected development SSH owner does not accept key passphrases.",
        }),
      },
    ]);
    expect(unlock).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await read;
    await picker.close();
  }
});
