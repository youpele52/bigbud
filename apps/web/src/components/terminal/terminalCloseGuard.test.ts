import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalStateStore } from "../../stores/terminal";
import { createSingleThreadTerminalState } from "../../stores/terminal/helpers.store";
import { useTerminalCloseConfirmationStore } from "../../stores/terminal/terminalCloseConfirmation.store";
import { resetTerminalStore } from "../../stores/terminal/terminal.store.test.helpers";
import { useTerminalLivenessStore } from "../../stores/terminal/terminalLiveness.store";
import { isTerminalBusy, requestTerminalClose } from "./terminalCloseGuard";

const thread = ThreadId.makeUnsafe("thread-1");

function setBusy(busy: boolean) {
  useTerminalLivenessStore.setState({
    byThreadId: { [thread]: { "term-1": { busy, idleClosesAt: null } } },
  });
}

describe("terminal close guard", () => {
  beforeEach(() => {
    resetTerminalStore();
    useTerminalStateStore.setState({
      terminalStateByThreadId: { [thread]: createSingleThreadTerminalState("term-1") },
      terminalLabelOverridesByThreadId: { [thread]: { "term-1": "Dev server" } },
    });
    useTerminalLivenessStore.setState({ byThreadId: {} });
    useTerminalCloseConfirmationStore.getState().dismiss();
  });

  it("closes an idle terminal at once without asking", () => {
    setBusy(false);
    const close = vi.fn();
    requestTerminalClose({ threadId: thread, terminalId: "term-1", close });
    expect(close).toHaveBeenCalledOnce();
    expect(useTerminalCloseConfirmationStore.getState().pending).toBeNull();
  });

  it("treats a terminal without liveness as not busy", () => {
    expect(isTerminalBusy(thread, "term-1")).toBe(false);
    const close = vi.fn();
    requestTerminalClose({ threadId: thread, terminalId: "term-1", close });
    expect(close).toHaveBeenCalledOnce();
  });

  it("asks before closing a busy terminal and labels it by its tab", () => {
    setBusy(true);
    const close = vi.fn();
    requestTerminalClose({ threadId: thread, terminalId: "term-1", close });
    expect(close).not.toHaveBeenCalled();
    const pending = useTerminalCloseConfirmationStore.getState().pending;
    expect(pending).toMatchObject({ watch: { threadId: thread, terminalId: "term-1" } });
    expect(pending!.description).toContain("“Dev server”");
    pending!.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the terminal when the request is dismissed", () => {
    setBusy(true);
    const close = vi.fn();
    requestTerminalClose({ threadId: thread, terminalId: "term-1", close });
    useTerminalCloseConfirmationStore.getState().dismiss();
    expect(useTerminalCloseConfirmationStore.getState().pending).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it("removes an exited terminal without asking, even if liveness still says busy", () => {
    setBusy(true);
    const close = vi.fn();
    requestTerminalClose({
      threadId: thread,
      terminalId: "term-1",
      close,
      options: { exited: true },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(useTerminalCloseConfirmationStore.getState().pending).toBeNull();
  });
});
