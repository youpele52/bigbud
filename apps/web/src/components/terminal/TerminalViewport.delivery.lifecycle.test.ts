import type { Terminal } from "@xterm/xterm";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, expect, it, vi } from "vitest";
import { forgetTerminalLaunch, recordTerminalLaunch } from "../../lib/terminalLaunchBinding";

afterEach(() => vi.useRealTimers());
import {
  createTerminalViewportDelivery,
  refreshTerminalViewportDelivery,
} from "./TerminalViewport.delivery";

it("does not hydrate or enable a failed replacement when notifying a mounted view", async () => {
  const pause = vi.fn();
  const hydrate = vi.fn();
  const delivery = { intake: { pause, hydrate } } as unknown as ReturnType<
    typeof createTerminalViewportDelivery
  >;
  const replaceDelivery = vi.fn(() => delivery);
  const subscribe = vi.fn();
  await refreshTerminalViewportDelivery({ status: "error", pid: null } as TerminalSessionSnapshot, {
    disposed: () => false,
    readDelivery: () => delivery,
    replaceDelivery,
    subscribe,
  });
  expect(pause).toHaveBeenCalledOnce();
  expect(hydrate).not.toHaveBeenCalled();
  expect(replaceDelivery).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
});

it("does not hydrate an obsolete delivery after subscription readiness awaits", async () => {
  const hydrate = vi.fn();
  let delivery = {
    writeBatcher: { isStopped: false },
    intake: { hydrate },
  } as unknown as ReturnType<typeof createTerminalViewportDelivery>;
  const original = delivery;
  const subscribe = vi.fn(async () => {
    delivery = { ...original };
  });
  await refreshTerminalViewportDelivery({ status: "running", pid: 1 } as TerminalSessionSnapshot, {
    disposed: () => false,
    readDelivery: () => delivery,
    replaceDelivery: () => delivery,
    subscribe,
  });
  expect(subscribe).toHaveBeenCalledOnce();
  expect(hydrate).not.toHaveBeenCalled();
});

it.each(["rejected", "stalled"] as const)(
  "pauses only the view when subscription readiness is %s",
  async (failure) => {
    vi.useFakeTimers();
    const pause = vi.fn();
    const hydrate = vi.fn();
    const delivery = {
      writeBatcher: { isStopped: false },
      intake: { hydrate, pause },
    } as unknown as ReturnType<typeof createTerminalViewportDelivery>;
    const pending = refreshTerminalViewportDelivery(
      { status: "running", pid: 1 } as TerminalSessionSnapshot,
      {
        disposed: () => false,
        readDelivery: () => delivery,
        replaceDelivery: () => delivery,
        subscribe: () =>
          failure === "rejected"
            ? Promise.reject(new Error("Subscription unavailable"))
            : new Promise<void>(() => undefined),
      },
    );
    await vi.advanceTimersByTimeAsync(20_001);
    await pending;
    expect(hydrate).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledOnce();
    if (failure === "stalled")
      expect(pause.mock.calls[0]![0].message).toContain("server outcome is confirmed");
  },
);

it("rejects stale streamed metadata and history before changing the drop-path mode", async () => {
  const fresh: TerminalSessionSnapshot = {
    threadId: "monotonic-delivery",
    terminalId: "shell",
    cwd: "/new",
    worktreePath: null,
    dropPathMode: "posix",
    status: "running",
    pid: 3,
    history: "C output",
    exitCode: null,
    exitSignal: null,
    runtimeGeneration: "C",
    updatedAt: "2026-10-29T12:00:03Z",
  };
  recordTerminalLaunch(fresh);
  const onSnapshot = vi.fn();
  const dropPathModeRef = { current: "posix" as const };
  const delivery = createTerminalViewportDelivery({
    terminalRef: { current: { options: {} } as Terminal },
    hasHandledExitRef: { current: false },
    dropPathModeRef,
    clearSelectionAction: vi.fn(),
    handleSessionExited: vi.fn(),
    onInputState: vi.fn(),
    onFailure: vi.fn(),
    onSnapshot,
  });
  try {
    const old = {
      ...fresh,
      runtimeGeneration: "B",
      cwd: "/old",
      history: "B output",
      dropPathMode: "powershell" as const,
      updatedAt: "2026-10-29T12:00:02Z",
    };
    delivery.intake.receive({
      type: "restarted",
      threadId: old.threadId,
      terminalId: old.terminalId,
      createdAt: old.updatedAt,
      snapshot: old,
    });
    await delivery.intake.hydrate(old);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(dropPathModeRef.current).toBe("posix");
    expect(delivery.intake.snapshotUpdatedAt).toBeNull();
    expect(delivery.intake.acceptsInput).toBe(false);
  } finally {
    delivery.dispose();
    forgetTerminalLaunch(fresh.threadId, fresh.terminalId);
  }
});

it.each(["started", "restarted"] as const)(
  "updates displayed session identity from a streamed %s snapshot",
  (type) => {
    const snapshot: TerminalSessionSnapshot = {
      threadId: "thread",
      terminalId: "shell",
      cwd: "/new",
      worktreePath: null,
      dropPathMode: "posix",
      status: "running",
      pid: 2,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-10-29T00:00:00Z",
      runtimeGeneration: "new",
    };
    const onSnapshot = vi.fn();
    const delivery = createTerminalViewportDelivery({
      terminalRef: { current: { options: {} } as Terminal },
      hasHandledExitRef: { current: false },
      dropPathModeRef: { current: "posix" },
      clearSelectionAction: vi.fn(),
      handleSessionExited: vi.fn(),
      onInputState: vi.fn(),
      onFailure: vi.fn(),
      onSnapshot,
    });
    try {
      delivery.intake.receive({
        type,
        threadId: snapshot.threadId,
        terminalId: snapshot.terminalId,
        createdAt: snapshot.updatedAt,
        snapshot,
      });
      expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
    } finally {
      delivery.dispose();
    }
  },
);
