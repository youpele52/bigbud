import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalWriteBatcher, type TerminalWriteBatcherOptions } from "./TerminalWriteBatcher";
import {
  BACKGROUND_DRAIN_INTERVAL_MS,
  BACKGROUND_FLUSH_DELAY_MS,
  BACKGROUND_LARGE_BACKLOG_BYTES,
  FOREGROUND_BUDGET_WINDOW_MS,
  FOREGROUND_IMMEDIATE_BUDGET_CHARS,
  FOREGROUND_IMMEDIATE_CHARS,
  ForegroundImmediateBudget,
} from "./TerminalWriteBatcher.pacing";
import { WRITE_PIPELINE_STALL_CHECK_MS } from "./TerminalWriteWatchdog";

describe("TerminalWriteBatcher pacing, repair hooks and watchdog", () => {
  const lanes: TerminalWriteBatcher[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    lanes.splice(0).forEach((lane) => lane.dispose());
    vi.runAllTimers();
    vi.useRealTimers();
  });
  function fixture(options: TerminalWriteBatcherOptions = {}) {
    const callbacks: Array<() => void> = [];
    const terminal = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) callbacks.push(callback);
      }),
    };
    const onFailure = vi.fn();
    const lane = new TerminalWriteBatcher(onFailure, options);
    lanes.push(lane);
    return { terminal, lane, callbacks, onFailure };
  }

  it("writes echo-sized visible output synchronously when the lane is idle", () => {
    const { terminal, lane, callbacks } = fixture({ immediateForeground: true });
    lane.write(terminal as never, "a");
    expect(terminal.write).toHaveBeenCalledWith("a", expect.any(Function));
    // Busy lanes keep ordering through the scheduler.
    lane.write(terminal as never, "b");
    expect(terminal.write).toHaveBeenCalledOnce();
    callbacks.shift()!();
    vi.advanceTimersByTime(1);
    expect(terminal.write).toHaveBeenLastCalledWith("b", expect.any(Function));
  });

  it("schedules large visible output and everything when the fast path is off", () => {
    const fast = fixture({ immediateForeground: true });
    fast.lane.write(fast.terminal as never, "x".repeat(FOREGROUND_IMMEDIATE_CHARS + 1));
    expect(fast.terminal.write).not.toHaveBeenCalled();
    const plain = fixture();
    plain.lane.write(plain.terminal as never, "a");
    expect(plain.terminal.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fast.terminal.write).toHaveBeenCalledOnce();
    expect(plain.terminal.write).toHaveBeenCalledOnce();
  });

  it("paces hidden output: delayed first flush and two writes in flight", () => {
    const { terminal, lane, callbacks } = fixture({ immediateForeground: true });
    lane.setForeground(false);
    lane.write(terminal as never, "x".repeat(40_000));
    vi.advanceTimersByTime(BACKGROUND_FLUSH_DELAY_MS - 1);
    expect(terminal.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(terminal.write).toHaveBeenCalledTimes(2);
    callbacks.shift()!();
    vi.advanceTimersByTime(BACKGROUND_DRAIN_INTERVAL_MS - 1);
    expect(terminal.write).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2);
    expect(terminal.write).toHaveBeenCalledTimes(3);
  });

  it("drains a large hidden backlog without the initial delay and resumes on show", () => {
    const { terminal, lane } = fixture();
    lane.setForeground(false);
    lane.write(terminal as never, "x".repeat(BACKGROUND_LARGE_BACKLOG_BYTES / 3 + 1));
    vi.advanceTimersByTime(1);
    expect(terminal.write).toHaveBeenCalledTimes(2);
    const hidden = fixture();
    hidden.lane.setForeground(false);
    hidden.lane.write(hidden.terminal as never, "z");
    hidden.lane.setForeground(true);
    vi.advanceTimersByTime(1);
    expect(hidden.terminal.write).toHaveBeenCalledOnce();
  });

  it("transforms and repairs visible writes only, running the repair after the parse", () => {
    const repaired = vi.fn();
    const prepareWrite = vi.fn(() => repaired);
    const { terminal, lane, callbacks } = fixture({
      transformWrite: (data) => data.toUpperCase(),
      prepareWrite,
    });
    lane.write(terminal as never, "abc", 3);
    vi.advanceTimersByTime(1);
    expect(terminal.write).toHaveBeenCalledWith("ABC", expect.any(Function));
    expect(prepareWrite).toHaveBeenCalledWith("ABC");
    expect(repaired).not.toHaveBeenCalled();
    callbacks.shift()!();
    expect(repaired).toHaveBeenCalledOnce();
    lane.setForeground(false);
    lane.write(terminal as never, "def");
    vi.advanceTimersByTime(BACKGROUND_FLUSH_DELAY_MS + 1);
    expect(terminal.write).toHaveBeenLastCalledWith("def", expect.any(Function));
    expect(prepareWrite).toHaveBeenCalledOnce();
  });

  it("keeps delivering when a repair step throws", () => {
    const onParsed = vi.fn();
    const { terminal, lane, callbacks } = fixture({
      onParsed,
      prepareWrite: () => () => {
        throw new Error("renderer gone");
      },
    });
    lane.write(terminal as never, "abc", 3);
    vi.advanceTimersByTime(1);
    callbacks.shift()!();
    expect(onParsed).toHaveBeenCalledWith(3);
    expect(lane.isStopped).toBe(false);
  });

  it("certifies a silent parser once and reports the stall", () => {
    const onStalled = vi.fn();
    const { terminal, lane, onFailure } = fixture({ onStalled });
    lane.write(terminal as never, "abc");
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS);
    expect(terminal.write).toHaveBeenLastCalledWith("", expect.any(Function));
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS);
    expect(onStalled).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(lane.isStopped).toBe(true);
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3);
    expect(onStalled).toHaveBeenCalledOnce();
  });

  it("treats a slow but progressing parser as healthy", () => {
    const onStalled = vi.fn();
    const { terminal, lane, callbacks } = fixture({ onStalled });
    lane.write(terminal as never, "abc");
    vi.advanceTimersByTime(1 + WRITE_PIPELINE_STALL_CHECK_MS);
    // The original write and then the FIFO probe complete before the second interval.
    callbacks.shift()!();
    callbacks.shift()!();
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 2);
    expect(onStalled).not.toHaveBeenCalled();
    expect(lane.isStopped).toBe(false);
  });
});

describe("ForegroundImmediateBudget", () => {
  it("admits tiny chunks and interactive ANSI redraws within a rolling budget", () => {
    let now = 0;
    const budget = new ForegroundImmediateBudget(() => now);
    expect(budget.admit("x".repeat(FOREGROUND_IMMEDIATE_CHARS), false)).toBe(true);
    const redraw = `\x1b[H${"r".repeat(FOREGROUND_IMMEDIATE_CHARS * 4)}`;
    expect(budget.admit(redraw, false)).toBe(false);
    expect(budget.admit(redraw, true)).toBe(true);
    expect(budget.admit("p".repeat(FOREGROUND_IMMEDIATE_CHARS * 4), true)).toBe(false);
    while (budget.admit(redraw, true));
    expect(budget.admit("a", false)).toBe(
      FOREGROUND_IMMEDIATE_BUDGET_CHARS % redraw.length >= FOREGROUND_IMMEDIATE_CHARS + 1,
    );
    now += FOREGROUND_BUDGET_WINDOW_MS;
    expect(budget.admit(redraw, true)).toBe(true);
  });
});
