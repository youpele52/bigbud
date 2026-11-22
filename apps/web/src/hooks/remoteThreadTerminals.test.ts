import { ThreadId } from "@bigbud/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn(async () => ({})) }));
vi.mock("../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: { open: mocks.open } }) }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../stores/remoteAccess/remoteAccess.store", () => ({
  areDisconnectedTargetsLoaded: () => true,
  isExecutionTargetDisconnected: () => false,
}));

import { useTerminalStateStore } from "../stores/terminal/terminal.store";
import { resetTerminalStore } from "../stores/terminal/terminal.store.test.helpers";
import { reconnectRemoteThreadTerminals } from "./remoteThreadTerminals";

const threadId = ThreadId.makeUnsafe("remote-thread");
const target = { threadId, executionTargetId: "ssh:remote", cwd: "/work" };

beforeEach(() => {
  resetTerminalStore();
  mocks.open.mockClear();
});

it("reopens nothing for a thread without terminals", async () => {
  await reconnectRemoteThreadTerminals(target);
  expect(mocks.open).not.toHaveBeenCalled();
});

it("reattaches every pane attach-only, restored or user-created, and never respawns", async () => {
  useTerminalStateStore.setState({
    terminalStateByThreadId: {
      [threadId]: {
        terminalOpen: true,
        terminalHeight: 280,
        terminalIds: ["restored", "fresh"],
        runningTerminalIds: [],
        activeTerminalId: "restored",
        terminalGroups: [{ id: "group-restored", terminalIds: ["restored", "fresh"] }],
        activeTerminalGroupId: "group-restored",
        restoredTerminalIds: ["restored"],
      },
    },
  });
  await reconnectRemoteThreadTerminals(target);
  expect(mocks.open).toHaveBeenCalledTimes(2);
  for (const terminalId of ["restored", "fresh"])
    expect(mocks.open).toHaveBeenCalledWith({
      threadId,
      executionTargetId: "ssh:remote",
      terminalId,
      cwd: "/work",
      attachOnly: true,
    });
});

it("ignores panes with nothing to reattach, but reports other failures", async () => {
  useTerminalStateStore.setState({
    terminalStateByThreadId: {
      [threadId]: {
        terminalOpen: true,
        terminalHeight: 280,
        terminalIds: ["ended", "live"],
        runningTerminalIds: [],
        activeTerminalId: "ended",
        terminalGroups: [{ id: "group-ended", terminalIds: ["ended", "live"] }],
        activeTerminalGroupId: "group-ended",
      },
    },
  });
  mocks.open.mockRejectedValueOnce({ _tag: "TerminalNotRunningError" });
  await expect(reconnectRemoteThreadTerminals(target)).resolves.toBeUndefined();
  mocks.open.mockRejectedValueOnce(new Error("ssh down"));
  await expect(reconnectRemoteThreadTerminals(target)).rejects.toThrow("ssh down");
});
