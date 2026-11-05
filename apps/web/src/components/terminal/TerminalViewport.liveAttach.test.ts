import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalRedrawNudge, liveModeSequence } from "./TerminalViewport.liveAttach";

const view = (type: "normal" | "alternate") => ({ buffer: { active: { type } } }) as never;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function nudge(geometry = { cols: 80, rows: 24 }) {
  const calls: Array<{ cols: number; rows: number }> = [];
  const resize = vi.fn(async (next: { cols: number; rows: number }) => {
    calls.push(next);
  });
  return { calls, resize, redraw: new TerminalRedrawNudge(resize, () => geometry) };
}

it("holds the probe size until the program redraws, but at least long enough to be observed", async () => {
  const { calls, redraw } = nudge();
  const done = redraw.request();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual([{ cols: 80, rows: 23 }]);
  redraw.observeOutput();
  await vi.advanceTimersByTimeAsync(149);
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await done;
  expect(calls).toEqual([
    { cols: 80, rows: 23 },
    { cols: 80, rows: 24 },
  ]);
});

it("restores after the deadline when a program never redraws, and ignores overlapping requests", async () => {
  const { calls, redraw } = nudge({ cols: 10, rows: 1 });
  const done = redraw.request();
  void redraw.request();
  await vi.advanceTimersByTimeAsync(749);
  expect(calls).toEqual([{ cols: 10, rows: 2 }]);
  await vi.advanceTimersByTimeAsync(1);
  await done;
  expect(calls).toEqual([
    { cols: 10, rows: 2 },
    { cols: 10, rows: 1 },
  ]);
});

it("still restores geometry when the probe resize fails", async () => {
  const { resize, redraw } = nudge();
  resize.mockRejectedValueOnce(new Error("not running"));
  await redraw.request();
  expect(resize).toHaveBeenLastCalledWith({ cols: 80, rows: 24 });
});

it("switches screens before re-asserting modes, and only when the view disagrees", () => {
  const modes = { sequence: "\x1b[?2004h\x1b[", alternateScreen: true };
  expect(liveModeSequence(view("normal"), modes)).toBe("\x1b[?1049h\x1b[?2004h\x1b[");
  expect(liveModeSequence(view("alternate"), modes)).toBe(modes.sequence);
  expect(liveModeSequence(view("alternate"), { ...modes, alternateScreen: false })).toBe(
    "\x1b[?1049l" + modes.sequence,
  );
  expect(liveModeSequence(view("normal"), undefined)).toBe("");
});
