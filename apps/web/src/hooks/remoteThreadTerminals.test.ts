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

it("reattaches restored panes with attachOnly and reopens user-created panes normally", async () => {
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
  expect(mocks.open).toHaveBeenCalledWith({
    threadId,
    executionTargetId: "ssh:remote",
    terminalId: "restored",
    cwd: "/work",
    attachOnly: true,
  });
  expect(mocks.open).toHaveBeenCalledWith({
    threadId,
    executionTargetId: "ssh:remote",
    terminalId: "fresh",
    cwd: "/work",
  });
});
