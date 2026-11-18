import { afterEach, expect, it, vi } from "vitest";
import { makeRemoteRestartFixture } from "./remoteAgentOwnedPty.restart.fixture.ts";

vi.mock("../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReady: () => undefined,
  assertSshExecutionTargetReadyAsync: async () => undefined,
}));
vi.mock("../ssh/sshCommand.ts", () => ({
  buildSshCommandInvocation: () => ({ command: "fixture", args: [] }),
}));
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "close escalates the same owned PTY and waits for durable exit (withheld ACKs: %s)",
  async (withholdControlAcks) => {
    const f = await makeRemoteRestartFixture({ withholdControlAcks });
    try {
      let closed = false;
      const close = f.runtime.runPromise(f.manager.close(f.input)).then(() => {
        closed = true;
      });
      await vi.waitFor(() =>
        expect(f.requests.some((frame) => frame.type === "ptyCloseRequest")).toBe(true),
      );
      await vi.waitFor(
        () => expect(f.requests.some((frame) => frame.type === "ptySignalRequest")).toBe(true),
        { timeout: 4000 },
      );
      const signal = f.requests.find((frame) => frame.type === "ptySignalRequest");
      expect(signal).toMatchObject({
        type: "ptySignalRequest",
        value: { ptyId: f.resource, signal: "SIGKILL" },
      });
      expect(closed).toBe(false);
      expect((await f.store.get('terminal:["thread","terminal"]'))?.state).not.toBe("terminal");
      f.exit();
      await vi.waitFor(() => expect(f.isPersisting()).toBe(true));
      expect(closed).toBe(false);
      f.releasePersist();
      await close;
      expect(closed).toBe(true);
      expect(f.pendingControls()).toBe(0);
      expect((await f.store.get('terminal:["thread","terminal"]'))?.state).toBe("terminal");
      expect(f.requests.filter((frame) => frame.type === "ptyCreateRequest")).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  },
);
