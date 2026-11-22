import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { rememberTerminalInventory } from "../../stores/terminal/terminal.store.inventory";
import {
  awaitTerminalServerRun,
  markAllTerminalPanesRestoredInState,
  markTerminalServerRunUnknown,
  observeTerminalServerRun,
  resetTerminalServerRunForTests,
} from "../../stores/terminal/terminal.store.serverRun";
import { openTerminalSession } from "./TerminalViewport.session.helpers";

const api = vi.hoisted(() => ({
  terminal: { open: vi.fn(), snapshot: vi.fn(), resize: vi.fn(async () => undefined) },
}));
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

const threadId = ThreadId.makeUnsafe("restart-thread");
const store = () => useTerminalStateStore.getState();
const panes = () => store().terminalStateByThreadId[threadId]?.terminalIds;
const markRestored = (inventoryFromNewRun: boolean) =>
  useTerminalStateStore.setState((state) =>
    markAllTerminalPanesRestoredInState(state, inventoryFromNewRun),
  );
const notRunning = (terminalId: string) => ({
  _tag: "TerminalNotRunningError",
  threadId,
  terminalId,
});
const running = (terminalId: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/root",
  worktreePath: null,
  dropPathMode: "posix",
  status: "running",
  pid: 42,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-11-22T10:00:00Z",
});
const input = (terminalId: string) =>
  ({
    disposed: () => false,
    terminalRef: { current: { cols: 80, rows: 24, focus: vi.fn() } },
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
  }) as unknown as Parameters<typeof openTerminalSession>[0];

beforeEach(() => {
  vi.stubGlobal("window", { requestAnimationFrame: (callback: () => void) => callback() });
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  resetTerminalServerRunForTests();
  rememberTerminalInventory(null);
  // Two user-created panes, opened (and spawned) under the first server run.
  useTerminalStateStore.setState({
    terminalStateByThreadId: {
      [threadId]: {
        terminalOpen: true,
        terminalHeight: 280,
        terminalIds: ["closed", "alive"],
        runningTerminalIds: [],
        activeTerminalId: "closed",
        terminalGroups: [{ id: "g", terminalIds: ["closed", "alive"] }],
        activeTerminalGroupId: "g",
      },
    } as never,
  });
  observeTerminalServerRun("run-1", markRestored);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const id of ["closed", "alive"]) forgetTerminalLaunch(threadId, id);
  useTerminalStateStore.setState({ terminalStateByThreadId: {}, panelTerminalStateByThreadId: {} });
});

describe("a backend restart without a page reload (plan §14)", () => {
  it("never respawns a pane the old run's host closed: the open waits, attaches, drops it", async () => {
    markTerminalServerRunUnknown();
    api.terminal.open.mockRejectedValueOnce(notRunning("closed"));
    // The view resynchronises on the new connection before the welcome arrives.
    const opening = openTerminalSession(input("closed"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.terminal.open).not.toHaveBeenCalled();

    observeTerminalServerRun("run-2", markRestored);
    await expect(opening).resolves.toBe(true);
    expect(api.terminal.open).toHaveBeenCalledOnce();
    expect(api.terminal.open.mock.calls[0]![0]).toMatchObject({ attachOnly: true });
    expect(panes()).toEqual(["alive"]);

    // A kept terminal the host still runs reattaches and keeps its pane.
    api.terminal.open.mockResolvedValueOnce(running("alive"));
    await expect(openTerminalSession(input("alive"))).resolves.toBe(true);
    expect(api.terminal.open.mock.calls[1]![0]).toMatchObject({ attachOnly: true });
    expect(panes()).toEqual(["alive"]);
  });

  it("prunes at once with an inventory the new connection already delivered", () => {
    markTerminalServerRunUnknown();
    store().reconcileTerminalInventory({
      type: "inventory",
      createdAt: "2099-01-01T10:00:00.000Z",
      sessions: [{ threadId, terminalId: "alive" }],
    });
    observeTerminalServerRun("run-2", markRestored);
    expect(panes()).toEqual(["alive"]);
    expect(store().restoredPanesAwaitingInventory).toBe(false);
  });

  it("waits for the next inventory when none arrived since the disconnect", () => {
    store().reconcileTerminalInventory({
      type: "inventory",
      createdAt: "2099-01-01T09:00:00.000Z",
      sessions: [],
    });
    markTerminalServerRunUnknown();
    observeTerminalServerRun("run-2", markRestored);
    // The old run's inventory proves nothing about the new one.
    expect(panes()).toEqual(["closed", "alive"]);
    expect(store().restoredPanesAwaitingInventory).toBe(true);
    store().reconcileTerminalInventory({
      type: "inventory",
      createdAt: "2099-01-01T10:00:00.000Z",
      sessions: [{ threadId, terminalId: "alive" }],
    });
    expect(panes()).toEqual(["alive"]);
  });

  it("changes nothing on a reconnect to the same run", async () => {
    markTerminalServerRunUnknown();
    observeTerminalServerRun("run-1", markRestored);
    await awaitTerminalServerRun();
    api.terminal.open.mockResolvedValueOnce(running("closed"));
    await openTerminalSession(input("closed"));
    expect(api.terminal.open.mock.calls[0]![0]).not.toHaveProperty("attachOnly");
    expect(panes()).toEqual(["closed", "alive"]);
  });

  it("an open goes ahead after the bounded wait when no welcome comes", async () => {
    vi.useFakeTimers();
    try {
      markTerminalServerRunUnknown();
      let done = false;
      void awaitTerminalServerRun(1_000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
