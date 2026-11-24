import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const operations = vi.hoisted(() => ({ closeTerminalConfirmed: vi.fn(async () => undefined) }));
vi.mock("../terminal/terminalLifecycle.operations", () => operations);
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: {} }) }));

import { useTerminalCloseConfirmationStore } from "../../stores/terminal/terminalCloseConfirmation.store";
import { useTerminalLivenessStore } from "../../stores/terminal/terminalLiveness.store";
import { closeAllProjectTerminals } from "./SidebarProjectTerminals.actions";

const thread = ThreadId.makeUnsafe("thread-1");
const targets = [
  { threadId: thread, terminalId: "a" },
  { threadId: thread, terminalId: "b" },
  { threadId: thread, terminalId: "c" },
];

describe("close all project terminals", () => {
  beforeEach(() => {
    operations.closeTerminalConfirmed.mockClear();
    useTerminalCloseConfirmationStore.getState().dismiss();
    useTerminalLivenessStore.setState({
      byThreadId: {
        [thread]: {
          a: { busy: true, idleClosesAt: null },
          b: { busy: true, idleClosesAt: null },
          c: { busy: false, idleClosesAt: null },
        },
      },
    });
  });

  it("always asks once, naming the running terminals, and closes nothing before confirming", () => {
    closeAllProjectTerminals(targets, ["OpenCode", "Terminal"]);
    const pending = useTerminalCloseConfirmationStore.getState().pending!;
    expect(pending.title).toBe("Close all 3 terminals?");
    expect(pending.description).toBe(
      "2 are still running (OpenCode, Terminal). Closing stops them and deletes their history.",
    );
    expect(pending.watch).toBeNull();
    expect(operations.closeTerminalConfirmed).not.toHaveBeenCalled();
  });

  it("asks even when nothing is busy", () => {
    closeAllProjectTerminals(targets.slice(2), []);
    expect(useTerminalCloseConfirmationStore.getState().pending!.description).toBe(
      "None are running a process. Closing stops them and deletes their history.",
    );
  });

  it("on confirm closes every terminal still live, skipping ones that ended meanwhile", () => {
    closeAllProjectTerminals(targets, ["OpenCode", "Terminal"]);
    useTerminalLivenessStore.setState({
      byThreadId: {
        [thread]: { a: { busy: true, idleClosesAt: null }, c: { busy: false, idleClosesAt: null } },
      },
    });
    useTerminalCloseConfirmationStore.getState().pending!.close();
    const closed = operations.closeTerminalConfirmed.mock.calls.map(
      (call) => (call as unknown as [{ terminalId: string }])[0].terminalId,
    );
    expect(closed).toEqual(["a", "c"]);
  });
});
