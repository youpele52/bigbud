import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { TerminalLimitError } from "@bigbud/contracts/workspace/terminal.limit.ts";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { openTerminalSession } from "./TerminalViewport.session.helpers";
import { makeTerminalStartupRecovery, readTerminalLimitError } from "./TerminalViewport.startup";

const api = vi.hoisted(() => ({ terminal: { open: vi.fn(), snapshot: vi.fn() } }));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => api }));
vi.mock("../../lib/threadMaterialization", () => ({ ensureThreadMaterialized: vi.fn() }));
vi.mock("../ui/toast.manager", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./terminalRecoveryGeometry", () => ({
  deferRecoveryFit: () => true,
  terminalResizeGeometry: () => ({ cols: 80, rows: 24 }),
}));
vi.mock("../../stores/remoteAccess/remoteAccess.store", () => ({
  areDisconnectedTargetsLoaded: () => true,
  isExecutionTargetDisconnected: () => false,
  REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE: "disconnected",
}));

const threadId = ThreadId.makeUnsafe("limit-thread");
const candidate = {
  threadId: "old-thread",
  terminalId: "old-pane",
  lastUsedAt: "2026-11-21T10:00:00.000Z",
  busy: true,
};
const limitError = new TerminalLimitError({ limit: 24, liveCount: 24, candidate });

describe("startup at the terminal limit", () => {
  it("reads a decoded limit refusal, also behind a cause", () => {
    expect(readTerminalLimitError(limitError)).toEqual({ limit: 24, liveCount: 24, candidate });
    expect(readTerminalLimitError({ cause: limitError })).toEqual({
      limit: 24,
      liveCount: 24,
      candidate,
    });
    expect(readTerminalLimitError(new Error("Terminal limit reached"))).toBeNull();
  });

  it("evict retries the open naming the candidate", async () => {
    const open = vi
      .fn<(superseded: () => boolean, attachOnly: boolean, evict?: unknown) => Promise<boolean>>()
      .mockRejectedValueOnce(limitError)
      .mockResolvedValueOnce(true);
    const prompt = vi.fn(async () => "evict" as const);
    const onFailure = vi.fn();
    await makeTerminalStartupRecovery({ open, onFailure, prompt }).run();
    expect(prompt).toHaveBeenCalledExactlyOnceWith({ limit: 24, liveCount: 24, candidate });
    expect(open).toHaveBeenLastCalledWith(expect.any(Function), false, {
      threadId: "old-thread",
      terminalId: "old-pane",
    });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("cancel fails the startup and removes the pane", async () => {
    const open = vi.fn(async () => {
      throw limitError;
    });
    const onFailure = vi.fn();
    const onLimitCancelled = vi.fn();
    await makeTerminalStartupRecovery({
      open,
      onFailure,
      onLimitCancelled,
      prompt: async () => "cancel",
    }).run();
    expect(open).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(limitError);
    expect(onLimitCancelled).toHaveBeenCalledOnce();
  });

  it("ignores the decision once recovery superseded the startup, and never asks attach-only", async () => {
    let decide!: (decision: "evict" | "cancel") => void;
    const open = vi.fn(async () => {
      throw limitError;
    });
    const onFailure = vi.fn();
    const onLimitCancelled = vi.fn();
    const prompt = vi.fn(() => new Promise<"evict" | "cancel">((resolve) => (decide = resolve)));
    const startup = makeTerminalStartupRecovery({ open, onFailure, onLimitCancelled, prompt });
    const pending = startup.run();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    startup.invalidate();
    decide("cancel");
    await pending;
    expect(onFailure).not.toHaveBeenCalled();
    expect(onLimitCancelled).not.toHaveBeenCalled();

    await startup.run(true);
    expect(prompt).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(limitError);
  });
});

describe("open request options", () => {
  const terminalId = "pane";
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
    updatedAt: "2026-11-21T10:00:00Z",
  };
  const input = (evict?: { threadId: string; terminalId: string }) =>
    ({
      disposed: () => false,
      terminalRef: { current: { cols: 80, rows: 24 } },
      fitAddonRef: { current: { fit: vi.fn() } },
      intake: { snapshotUpdatedAt: null, hydrate: vi.fn() },
      threadId,
      terminalId,
      cwd: "/root",
      worktreePathRef: { current: undefined },
      dropPathModeRef: { current: "posix" },
      waitForTypography: async () => undefined,
      autoFocusRef: { current: false },
      containerRef: { current: { getBoundingClientRect: () => ({ width: 800, height: 400 }) } },
      ...(evict ? { evict } : {}),
    }) as unknown as Parameters<typeof openTerminalSession>[0];

  beforeEach(() => {
    vi.stubGlobal("window", { requestAnimationFrame: (callback: () => void) => callback() });
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
    api.terminal.open.mockResolvedValue(failedSnapshot);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    forgetTerminalLaunch(threadId, terminalId);
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("a restored pane opens attach-only; a new pane does not", async () => {
    await expect(openTerminalSession(input())).rejects.toThrow("did not start");
    expect(api.terminal.open.mock.calls[0]![0]).not.toHaveProperty("attachOnly");

    useTerminalStateStore.setState({
      terminalStateByThreadId: {
        [threadId]: {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds: [terminalId],
          runningTerminalIds: [],
          activeTerminalId: terminalId,
          terminalGroups: [{ id: "g", terminalIds: [terminalId] }],
          activeTerminalGroupId: "g",
          restoredTerminalIds: [terminalId],
        },
      } as never,
    });
    // A restored pane whose terminal did not run is dropped, never shown as an error pane.
    await expect(openTerminalSession(input())).resolves.toBe(true);
    expect(api.terminal.open.mock.calls[1]![0]).toMatchObject({ attachOnly: true });
    expect(useTerminalStateStore.getState().terminalStateByThreadId[threadId]).toBeUndefined();
  });

  it("drops a restored pane with nothing to attach (an ended search hit)", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadId: {
        [threadId]: {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds: [terminalId, "other"],
          runningTerminalIds: [],
          activeTerminalId: terminalId,
          terminalGroups: [{ id: "g", terminalIds: [terminalId, "other"] }],
          activeTerminalGroupId: "g",
          restoredTerminalIds: [terminalId],
        },
      } as never,
    });
    api.terminal.open.mockRejectedValueOnce({
      _tag: "TerminalNotRunningError",
      threadId,
      terminalId,
    });
    await expect(openTerminalSession(input())).resolves.toBe(true);
    expect(useTerminalStateStore.getState().terminalStateByThreadId[threadId]?.terminalIds).toEqual(
      ["other"],
    );
    // A user-created pane's failure still surfaces as an error.
    api.terminal.open.mockRejectedValueOnce({
      _tag: "TerminalNotRunningError",
      threadId,
      terminalId: "other",
    });
    await expect(openTerminalSession({ ...input(), terminalId: "other" })).rejects.toMatchObject({
      _tag: "TerminalNotRunningError",
    });
  });

  it("a limit retry names the pane to evict", async () => {
    const evict = { threadId: "old-thread", terminalId: "old-pane" };
    await expect(openTerminalSession(input(evict))).rejects.toThrow("did not start");
    expect(api.terminal.open).toHaveBeenCalledWith(expect.objectContaining({ evict }));
  });
});
