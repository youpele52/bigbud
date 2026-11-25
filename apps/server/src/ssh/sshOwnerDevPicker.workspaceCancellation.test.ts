import { expect, it, vi } from "vitest";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";

it("skips a canceled queued snapshot without aborting the active owner request", async () => {
  const executionTargetId = "ssh:disposable-watch-test";
  const owner = {
    listRemoteFolders: vi.fn(),
    listAliases: vi.fn(),
    inspectTrust: vi.fn(),
    approveTrust: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(),
  };
  const picker = makeSshOwnerDevPicker({
    executionTargetId,
    host: "127.0.0.1",
    startOwner: async () => owner,
  });
  const active = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = picker.withOwner(executionTargetId, async () => {
    active.resolve();
    await release.promise;
    return "still running";
  });
  try {
    await active.promise;
    const abort = new AbortController();
    const snapshot = vi.fn(async () => "never dispatched");
    const queued = picker.withOwner(executionTargetId, snapshot, abort.signal);
    const observed = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    expect(owner.close).not.toHaveBeenCalled();
    release.resolve();
    await expect(first).resolves.toBe("still running");
    await observed;
    expect(snapshot).not.toHaveBeenCalled();
    await expect(picker.withOwner(executionTargetId, async () => "next subscriber")).resolves.toBe(
      "next subscriber",
    );
  } finally {
    release.resolve();
    await first;
    await picker.close();
  }
});
