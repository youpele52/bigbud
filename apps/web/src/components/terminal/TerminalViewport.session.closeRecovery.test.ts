import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import {
  TerminalSessionLookupError,
  type TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";
import {
  beginTerminalLifecycle,
  readTerminalLifecycle,
  updateTerminalLifecycle,
  useTerminalLifecycleStore,
} from "../../stores/terminal/terminalLifecycle.store";
import { openTerminalSession } from "./TerminalViewport.session.helpers";
import { releaseUnboundCloseFailure } from "./terminalLifecycle.recovery";

const api = vi.hoisted(() => ({ terminal: { open: vi.fn(), snapshot: vi.fn() } }));
const materialize = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => api }));
vi.mock("../../lib/threadMaterialization", () => ({ ensureThreadMaterialized: materialize }));
vi.mock("../ui/toast.manager", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./terminalRecoveryGeometry", () => ({
  deferRecoveryFit: () => true,
  terminalResizeGeometry: () => ({ cols: 100, rows: 24 }),
}));
vi.mock("../../stores/remoteAccess/remoteAccess.store", () => ({
  areDisconnectedTargetsLoaded: () => true,
  isExecutionTargetDisconnected: () => false,
  REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE: "disconnected",
}));

const threadId = ThreadId.makeUnsafe("close-recovery");
const terminalId = "default";
const lookupMiss = new TerminalSessionLookupError({ threadId, terminalId });
const failedSnapshot: TerminalSessionSnapshot = {
  threadId,
  terminalId,
  cwd: "/root",
  worktreePath: null,
  dropPathMode: "posix",
  status: "error",
  pid: null,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-11-20T20:06:51Z",
  runtimeGeneration: "fresh",
};

function refuseClose() {
  const operation = beginTerminalLifecycle(threadId, terminalId, "close")!;
  updateTerminalLifecycle(threadId, terminalId, operation, {
    phase: "error",
    error: "Previous terminal ownership has not been recovered.",
  });
}

function openInput(attachOnly: () => boolean) {
  const terminal = { cols: 100, rows: 24 };
  return {
    disposed: () => false,
    terminalRef: { current: terminal },
    fitAddonRef: { current: { fit: vi.fn() } },
    intake: { snapshotUpdatedAt: null, hydrate: vi.fn() },
    threadId,
    terminalId,
    executionTargetId: "ssh:host=dev-1&transport=agent",
    cwd: "/root",
    worktreePathRef: { current: undefined },
    dropPathModeRef: { current: "posix" },
    waitForTypography: async () => undefined,
    autoFocusRef: { current: false },
    containerRef: { current: { getBoundingClientRect: () => ({ width: 800, height: 400 }) } },
    attachOnly,
  } as unknown as Parameters<typeof openTerminalSession>[0];
}

beforeEach(() => {
  vi.stubGlobal("window", { requestAnimationFrame: (callback: () => void) => callback() });
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  useTerminalLifecycleStore.setState({ operations: {} });
  forgetTerminalLaunch(threadId, terminalId);
});

describe("refused close recovery", () => {
  it("releases only a refused close on a structured lookup miss for the same pane", () => {
    expect(releaseUnboundCloseFailure({ error: lookupMiss, threadId, terminalId })).toBe(false);
    beginTerminalLifecycle(threadId, terminalId, "close");
    // An in-flight close is never released.
    expect(releaseUnboundCloseFailure({ error: lookupMiss, threadId, terminalId })).toBe(false);
    useTerminalLifecycleStore.setState({ operations: {} });
    refuseClose();
    const other = new TerminalSessionLookupError({ threadId, terminalId: "other" });
    expect(releaseUnboundCloseFailure({ error: other, threadId, terminalId })).toBe(false);
    expect(releaseUnboundCloseFailure({ error: new Error("x"), threadId, terminalId })).toBe(false);
    expect(readTerminalLifecycle(threadId, terminalId)?.phase).toBe("error");
    expect(releaseUnboundCloseFailure({ error: lookupMiss, threadId, terminalId })).toBe(true);
    expect(readTerminalLifecycle(threadId, terminalId)).toBeUndefined();
  });

  it("turns an attach-only lookup miss after a refused close into a real open", async () => {
    refuseClose();
    api.terminal.snapshot.mockRejectedValueOnce(lookupMiss);
    api.terminal.open.mockResolvedValueOnce(failedSnapshot);

    const startup = openTerminalSession(
      openInput(() => Boolean(readTerminalLifecycle(threadId, terminalId))),
    );

    await expect(startup).rejects.toThrow("The terminal did not start");
    expect(api.terminal.snapshot).toHaveBeenCalledOnce();
    expect(materialize).toHaveBeenCalledWith(threadId);
    expect(api.terminal.open).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, terminalId, executionTargetId: expect.any(String) }),
    );
    expect(readTerminalLifecycle(threadId, terminalId)).toBeUndefined();
  });

  it("keeps attach-only when the view itself owns a running process", async () => {
    refuseClose();
    api.terminal.snapshot.mockRejectedValueOnce(lookupMiss);

    await expect(openTerminalSession(openInput(() => true))).rejects.toBe(lookupMiss);
    expect(api.terminal.open).not.toHaveBeenCalled();
  });
});
