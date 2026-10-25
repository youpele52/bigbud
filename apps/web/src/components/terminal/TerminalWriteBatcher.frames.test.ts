import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_HOLD_SAFETY_MS,
  LATENCY_SENSITIVE_FRAME_HOLD_SAFETY_MS,
  TERMINAL_WRITE_LIMITS,
  TerminalWriteBatcher,
  type TerminalWriteBatcherOptions,
} from "./TerminalWriteBatcher";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

describe("TerminalWriteBatcher frames, window and credits", () => {
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
      write: vi.fn((_data: string, callback: () => void) => callbacks.push(callback)),
    };
    const lane = new TerminalWriteBatcher(vi.fn(), options);
    lanes.push(lane);
    const written = () => terminal.write.mock.calls.map((call) => call[0]).join("");
    return { terminal, lane, callbacks, written };
  }

  it("holds an open synchronized frame until its end marker arrives", () => {
    const { terminal, lane, written } = fixture();
    lane.write(terminal as never, `prompt$ ${BSU}row one`);
    vi.advanceTimersByTime(10);
    expect(written()).toBe("prompt$ ");
    expect(lane.heldFrames).toBe(1);
    lane.write(terminal as never, ` row two${ESU}`);
    vi.advanceTimersByTime(10);
    expect(written()).toBe(`prompt$ ${BSU}row one row two${ESU}`);
  });

  it("releases a held frame after the safety delay instead of stranding it", () => {
    const { terminal, lane, written } = fixture();
    lane.write(terminal as never, `${BSU}partial`);
    vi.advanceTimersByTime(FRAME_HOLD_SAFETY_MS - 20);
    expect(terminal.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(written()).toBe(`${BSU}partial`);
  });

  it("uses the short hold right after user input", () => {
    const { terminal, lane, written } = fixture({ isLatencySensitive: () => true });
    lane.write(terminal as never, `${BSU}echo`);
    vi.advanceTimersByTime(LATENCY_SENSITIVE_FRAME_HOLD_SAFETY_MS - 20);
    expect(terminal.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(written()).toBe(`${BSU}echo`);
  });

  it("never holds output in front of a barrier", () => {
    const { terminal, lane, written } = fixture();
    lane.write(terminal as never, `${BSU}partial`);
    lane.barrier(() => undefined);
    vi.advanceTimersByTime(10);
    expect(written()).toBe(`${BSU}partial`);
  });

  it("bounds pipelined parser writes by the in-flight window", () => {
    const { terminal, lane, callbacks } = fixture();
    const chunk = "x".repeat(TERMINAL_WRITE_LIMITS.writeUnits);
    for (let i = 0; i < TERMINAL_WRITE_LIMITS.inFlightWrites + 3; i++)
      lane.write(terminal as never, chunk);
    vi.runAllTimers();
    expect(terminal.write).toHaveBeenCalledTimes(TERMINAL_WRITE_LIMITS.inFlightWrites);
    callbacks.shift()?.();
    vi.runAllTimers();
    expect(terminal.write).toHaveBeenCalledTimes(TERMINAL_WRITE_LIMITS.inFlightWrites + 1);
  });

  it("releases credit only after xterm parses it, never for discarded output", () => {
    const onParsed = vi.fn();
    const { terminal, lane, callbacks } = fixture({ onParsed });
    lane.write(terminal as never, "notice");
    lane.write(terminal as never, "alpha", 5);
    expect(lane.outstandingCredit).toBe(5);
    vi.runAllTimers();
    expect(onParsed).not.toHaveBeenCalled();
    callbacks.shift()?.();
    expect(onParsed).toHaveBeenCalledExactlyOnceWith(5);
    expect(lane.outstandingCredit).toBe(0);
    lane.write(terminal as never, "discarded", 9);
    vi.runAllTimers();
    lane.dispose();
    callbacks.shift()?.();
    expect(onParsed).toHaveBeenCalledOnce();
    expect(lane.outstandingCredit).toBe(0);
  });

  it("keeps credit on a held frame tail until the tail is parsed", () => {
    const onParsed = vi.fn();
    const { terminal, lane, callbacks } = fixture({ onParsed });
    const data = `done${BSU}open`;
    lane.write(terminal as never, data, data.length);
    vi.advanceTimersByTime(10);
    callbacks.shift()?.();
    expect(onParsed).toHaveBeenCalledExactlyOnceWith(4);
    lane.write(terminal as never, `${ESU}`, ESU.length);
    vi.advanceTimersByTime(10);
    callbacks.shift()?.();
    expect(onParsed).toHaveBeenLastCalledWith(BSU.length + 4 + ESU.length);
    expect(lane.outstandingCredit).toBe(0);
  });

  it("serves the focused terminal's lane first without starving siblings", () => {
    const order: string[] = [];
    const make = (id: string) => {
      const lane = new TerminalWriteBatcher();
      lanes.push(lane);
      const terminal = { write: (_data: string, done: () => void) => (order.push(id), done()) };
      return { lane, terminal };
    };
    const background = make("background");
    const focused = make("focused");
    focused.lane.setFocused(true);
    background.lane.write(background.terminal as never, "b");
    focused.lane.write(focused.terminal as never, "f");
    vi.runAllTimers();
    expect(order).toEqual(["focused", "background"]);
  });
});
