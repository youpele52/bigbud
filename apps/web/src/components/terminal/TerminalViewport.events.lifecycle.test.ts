import { expect, it, vi } from "vitest";
import { makeApplyTerminalEvent } from "./TerminalViewport.events";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";

it.each(["started", "restarted"] as const)(
  "%s invalidates an older exit barrier even when the new generation also exits before drain",
  (type) => {
    vi.useFakeTimers();
    const callbacks: Array<() => void> = [];
    const terminal = { write: vi.fn((_data, done) => callbacks.push(done)), clear: vi.fn() };
    const lane = new TerminalWriteBatcher();
    const closed = vi.fn();
    const base = { threadId: "thread", terminalId: "terminal", createdAt: "2026-10-10T00:00:00Z" };
    const apply = makeApplyTerminalEvent({
      terminalRef: { current: terminal as never },
      hasHandledExitRef: { current: false },
      dropPathModeRef: { current: "posix" },
      writeBatcher: lane,
      replaySnapshot: (snapshot) => {
        lane.write(terminal as never, "\x1bc");
        lane.write(terminal as never, snapshot.history);
      },
      isDisposed: () => false,
      clearSelectionAction: () => undefined,
      handleSessionExited: closed,
    });
    try {
      apply({ ...base, type: "output", data: "A-output" });
      vi.runAllTimers(); // Withhold A's first parser callback.
      apply({ ...base, type: "exited", exitCode: 0, exitSignal: null });
      apply({
        ...base,
        type,
        snapshot: {
          threadId: base.threadId,
          terminalId: base.terminalId,
          cwd: "/synthetic",
          worktreePath: null,
          dropPathMode: "posix",
          status: "running",
          pid: 2,
          history: "B-history",
          exitCode: null,
          exitSignal: null,
          updatedAt: base.createdAt,
        },
      });
      apply({ ...base, type: "output", data: "B-output" });
      apply({ ...base, type: "exited", exitCode: 1, exitSignal: null });
      expect(closed).not.toHaveBeenCalled();
      callbacks.shift()!();
      vi.runAllTimers(); // A's exit notice is now in flight.
      expect(closed).not.toHaveBeenCalled();
      callbacks.shift()!();
      vi.runAllTimers(); // A's barrier executes, then B's output is withheld.
      expect(terminal.write.mock.calls.at(-1)?.[0]).toContain("B-output");
      expect(closed).not.toHaveBeenCalled();
      callbacks.shift()!();
      vi.runAllTimers(); // Only B may close, after B's final parser callback.
      expect(closed).toHaveBeenCalledOnce();
      expect(lane.queuedBytes).toBe(0);
    } finally {
      lane.dispose();
      vi.runAllTimers();
      vi.useRealTimers();
    }
  },
);
