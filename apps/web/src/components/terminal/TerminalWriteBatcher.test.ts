import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalWriteBatcher, TERMINAL_WRITE_LIMITS } from "./TerminalWriteBatcher";

describe("TerminalWriteBatcher", () => {
  const lanes: TerminalWriteBatcher[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    lanes.splice(0).forEach((lane) => lane.dispose());
    vi.runAllTimers();
    vi.useRealTimers();
  });
  function fixture() {
    const callbacks: Array<() => void> = [];
    const terminal = {
      write: vi.fn((_data: string, callback: () => void) => callbacks.push(callback)),
    };
    const failure = vi.fn();
    const lane = new TerminalWriteBatcher(failure);
    lanes.push(lane);
    return { terminal, lane, failure, callbacks };
  }
  it("pipelines output within the window but barriers wait for every in-flight write", () => {
    const { terminal, lane, callbacks } = fixture();
    const barrier = vi.fn();
    lane.write(terminal as never, "alpha");
    vi.runAllTimers();
    lane.write(terminal as never, "beta");
    lane.barrier(barrier);
    lane.write(terminal as never, "gamma");
    lane.flush();
    vi.runAllTimers();
    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(terminal.write).toHaveBeenNthCalledWith(2, "beta", expect.any(Function));
    expect(barrier).not.toHaveBeenCalled();
    callbacks.shift()?.();
    vi.runAllTimers();
    expect(barrier).not.toHaveBeenCalled();
    callbacks.shift()?.();
    vi.runAllTimers();
    expect(barrier).toHaveBeenCalledOnce();
    expect(terminal.write).toHaveBeenNthCalledWith(3, "gamma", expect.any(Function));
  });
  it("fences old and duplicate callbacks after disposal", () => {
    const { terminal, lane, callbacks } = fixture();
    lane.write(terminal as never, "alpha");
    vi.runAllTimers();
    const callback = callbacks[0]!;
    lane.write(terminal as never, "beta");
    lane.dispose();
    callback();
    callback();
    vi.runAllTimers();
    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(lane.queuedBytes).toBe(0);
  });
  it("visibly pauses on exhaustion without pretending discarded work parsed", async () => {
    const { terminal, lane, failure } = fixture();
    lane.write(terminal as never, "alpha");
    vi.runAllTimers();
    const idle = lane.whenIdle();
    const rejected = expect(idle).rejects.toThrow("budget");
    lane.write(terminal as never, "x".repeat(TERMINAL_WRITE_LIMITS.bytes));
    await rejected;
    expect(failure).toHaveBeenCalledOnce();
    expect(lane.isStopped).toBe(true);
    expect(lane.queuedBytes).toBe(0);
    lane.write(terminal as never, "never");
    vi.runAllTimers();
    expect(terminal.write).toHaveBeenCalledTimes(1);
  });
  it("bounds no-newline and unterminated OSC/DCS workloads", () => {
    for (const prefix of ["", "\x1b]52;c;", "\x1bP"]) {
      const { terminal, lane, failure } = fixture();
      lane.write(terminal as never, prefix + "x".repeat(400_000));
      expect(failure).toHaveBeenCalledOnce();
      expect(terminal.write).not.toHaveBeenCalled();
    }
  });
  it("splits bounded writes without breaking surrogate pairs and yields to siblings", () => {
    const one = fixture();
    const two = fixture();
    const units = TERMINAL_WRITE_LIMITS.writeUnits;
    one.lane.write(one.terminal as never, "x".repeat(units - 1) + "😀end");
    two.lane.write(two.terminal as never, "sibling");
    vi.runAllTimers();
    expect(one.terminal.write.mock.calls[0]?.[0]).toBe("x".repeat(units - 1));
    expect(two.terminal.write).toHaveBeenCalledOnce();
    one.callbacks.shift()?.();
    vi.runAllTimers();
    expect(one.terminal.write.mock.calls[1]?.[0]).toBe("😀end");
  });
  it("contains synchronous writer and owned barrier exceptions", () => {
    const { terminal, lane, failure } = fixture();
    terminal.write.mockImplementation(() => {
      throw new Error("writer failed");
    });
    lane.write(terminal as never, "x");
    vi.runAllTimers();
    expect(failure).toHaveBeenCalledOnce();
    const other = fixture();
    other.lane.barrier(() => {
      throw new Error("barrier failed");
    });
    vi.runAllTimers();
    expect(other.failure).toHaveBeenCalledOnce();
  });
  it("coalesces a 1000-event burst into bounded parser work instead of 1000 timers", () => {
    const { terminal, lane } = fixture();
    for (let i = 0; i < 1000; i++) lane.write(terminal as never, "x");
    vi.runAllTimers();
    expect(terminal.write).toHaveBeenCalledExactlyOnceWith("x".repeat(1000), expect.any(Function));
  });
  it("sustained synchronous writers alternate fairly and yield each round to ordinary work", () => {
    // Freeze the clock so only the per-macrotask turn bound can stop a drain.
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const order: string[] = [];
    const createWriter = (id: string) => {
      const lane = new TerminalWriteBatcher();
      lanes.push(lane);
      let writes = 0;
      const terminal = {
        write: (_data: string, done: () => void) => {
          order.push(id);
          if (++writes < 50) lane.write(terminal as never, id);
          done();
        },
      };
      lane.write(terminal as never, id);
      return lane;
    };
    try {
      const a = createWriter("A");
      const b = createWriter("B");
      setTimeout(() => order.push("chat/input"), 0);
      vi.runAllTimers();
      expect(order.slice(0, 3)).toEqual(["A", "B", "chat/input"]);
      expect(order.filter((id) => id !== "chat/input")).toEqual(
        Array.from({ length: 50 }, () => ["A", "B"]).flat(),
      );
      expect(a.queuedBytes).toBe(0);
      expect(b.queuedBytes).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});
