import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { makeRemoteRestartFixture } from "./remoteAgentOwnedPty.restart.fixture.ts";

vi.mock("../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReady: () => undefined,
  assertSshExecutionTargetReadyAsync: async () => undefined,
}));
vi.mock("../ssh/sshCommand.ts", () => ({
  buildSshCommandInvocation: () => ({ command: "fixture", args: [] }),
}));
afterEach(() => vi.restoreAllMocks());

it("explicit restart waits for remote exit AND committed owner release before creating a fresh resource", async () => {
  const f = await makeRemoteRestartFixture();
  try {
    const exited = vi.fn();
    await f.runtime.runPromise(
      f.manager.subscribe((event) =>
        Effect.sync(() => {
          if (event.type === "exited") exited();
        }),
      ),
    );
    const restart = f.runtime.runPromise(f.manager.restart(f.input));
    await vi.waitFor(() =>
      expect(f.requests.some((frame) => frame.type === "ptyCloseRequest")).toBe(true),
    );
    expect(f.requests.filter((frame) => frame.type === "ptyCreateRequest")).toHaveLength(1);
    expect(f.requests.filter((frame) => frame.type === "ptyAttachRequest")).toHaveLength(1);
    f.exit();
    await vi.waitFor(() => expect(f.isPersisting()).toBe(true));
    expect(exited).not.toHaveBeenCalled(); // Restart must not close the UI's terminal tab.
    expect(f.requests.filter((frame) => frame.type === "ptyCreateRequest")).toHaveLength(1);
    expect(f.requests.filter((frame) => frame.type === "ptyAttachRequest")).toHaveLength(1);
    f.releasePersist();
    const fresh = await restart;
    expect(fresh.pid).not.toBe(f.opened.pid);
    expect(fresh.history).toBe("");
    expect(fresh.historyUnavailable).toBeUndefined();
    expect(fresh.historyTruncated).toBeUndefined();
    expect(f.requests.filter((frame) => frame.type === "ptyCreateRequest")).toHaveLength(2);
    const owner = await f.store.get('terminal:["thread","terminal"]');
    expect(owner?.resourceId).not.toBe(f.resource);
    expect(exited).not.toHaveBeenCalled();
  } finally {
    await f.dispose();
  }
});

it.each(["timeout", "persist-failure"] as const)(
  "%s fails visibly without replacement or reattachment",
  async (kind) => {
    const f = await makeRemoteRestartFixture();
    try {
      const restart = f.runtime.runPromise(f.manager.restart(f.input));
      const failed = expect(restart).rejects.toThrow(
        kind === "timeout" ? "timed out" : "owner persistence failed",
      );
      await vi.waitFor(() =>
        expect(f.requests.some((frame) => frame.type === "ptyCloseRequest")).toBe(true),
      );
      if (kind === "persist-failure") {
        f.exit();
        await vi.waitFor(() => expect(f.isPersisting()).toBe(true));
        f.rejectPersist(new Error("owner persistence failed"));
      }
      await failed;
      if (kind === "timeout") {
        // A late exit must not remove the failed restart fence while owner persistence is pending.
        f.exit();
        await vi.waitFor(() => expect(f.isPersisting()).toBe(true));
      }
      expect(f.requests.filter((frame) => frame.type === "ptyCreateRequest")).toHaveLength(1);
      expect(f.requests.filter((frame) => frame.type === "ptyAttachRequest")).toHaveLength(1);
      if (kind === "persist-failure") {
        await expect(f.runtime.runPromise(f.manager.restart(f.input))).rejects.toThrow(
          "owner persistence failed",
        );
        expect(f.requests.filter((frame) => frame.type === "ptyCreateRequest")).toHaveLength(1);
        expect(f.requests.filter((frame) => frame.type === "ptyAttachRequest")).toHaveLength(1);
      } else {
        const retry = f.runtime.runPromise(f.manager.restart(f.input));
        await vi.waitFor(() =>
          expect(f.requests.filter((frame) => frame.type === "ptyCreateRequest")).toHaveLength(1),
        );
        f.releasePersist();
        expect((await retry).historyUnavailable).toBeUndefined();
      }
    } finally {
      await f.dispose();
    }
  },
);
