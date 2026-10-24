import { describe, expect, it } from "vitest";
import { createHistorySwipeRecognizer } from "./browserHistoryGestures.logic";

function swipe(deltas: number[], vertical = 0) {
  const recognizer = createHistorySwipeRecognizer();
  recognizer.begin();
  const results = deltas.map((deltaX, index) =>
    recognizer.push({ deltaX, deltaY: vertical, time: 10 + index * 20, blocked: false }),
  );
  return { recognizer, results, committed: results.find((result) => result !== null) ?? null };
}

describe("browser history swipe recognition", () => {
  it.each([
    [[-60, -60, -60], "back"],
    [[60, 60, 60], "forward"],
  ] as const)("commits %j once, as soon as the swipe qualifies", (deltas, direction) => {
    const { recognizer, results } = swipe([...deltas]);
    expect(results).toEqual([null, null, direction]);
    expect(recognizer.isActive()).toBe(false);
    expect(recognizer.push({ deltaX: 500, deltaY: 0, time: 80, blocked: false })).toBeNull();
    recognizer.begin();
    const next = [120, 140, 160].map((time) =>
      recognizer.push({ deltaX: 60, deltaY: 0, time, blocked: false }),
    );
    expect(next.at(-1)).toBe("forward");
  });

  it("commits a real macOS flick before its momentum and late native scroll end", () => {
    // macOS drops the phase-ended wheel when momentum follows, so the native
    // scroll end only arrives after ~1 s of coasting.
    const recognizer = createHistorySwipeRecognizer();
    recognizer.begin();
    let time = 0;
    let committedAt: number | null = null;
    for (let index = 0; index < 10; index += 1) {
      time += 16;
      const result = recognizer.push({ deltaX: -30, deltaY: 1, time, blocked: false });
      if (result === "back") committedAt = time;
    }
    for (let delta = 30; delta > 0.5; delta *= 0.95) {
      time += 16;
      expect(recognizer.push({ deltaX: -delta, deltaY: 0, time, blocked: false })).toBeNull();
    }
    expect(committedAt).toBe(96);
    expect(time).toBeGreaterThan(1000);
  });

  it.each([
    [[10, 10, 10], 0],
    [[200], 0],
    [[0, 0, -200], 0],
    [[100, 100], 0],
    [[60, 60, 60], 30],
    [[0, 0, 0], 60],
    [[-50, -50, 30, -200], 0],
    [[60, -10, -10, -10, 200], 0],
  ] as const)(
    "rejects small, impulsive, diagonal, vertical or reversed movement: %j/%s",
    (deltas, vertical) => {
      expect(swipe([...deltas], vertical).committed).toBeNull();
    },
  );

  it("locks out a gesture that ever touches a scroller or site-owned surface", () => {
    const { recognizer } = swipe([80, 40]);
    expect(recognizer.push({ deltaX: 60, deltaY: 0, time: 60, blocked: true })).toBeNull();
    expect(recognizer.push({ deltaX: 200, deltaY: 0, time: 80, blocked: false })).toBeNull();
  });

  it("rejects slow accumulation, pauses and invalid deltas", () => {
    const slow = createHistorySwipeRecognizer();
    slow.begin();
    const results = Array.from({ length: 30 }, (_, index) =>
      slow.push({ deltaX: 8, deltaY: 0, time: 10 + index * 150, blocked: false }),
    );
    expect(results.every((result) => result === null)).toBe(true);
    expect(slow.snapshot().rejection).toBe("sample-timing");
    for (const sample of [
      { deltaX: 200, deltaY: 0, time: 300, blocked: false },
      { deltaX: NaN, deltaY: 0, time: 60, blocked: false },
      { deltaX: 200, deltaY: Infinity, time: 60, blocked: false },
      { deltaX: 200, deltaY: 0, time: 5, blocked: false },
    ]) {
      const { recognizer } = swipe([60, 40]);
      expect(recognizer.push(sample)).toBeNull();
    }
  });

  it("requires an explicit begin and respects cancellation and end", () => {
    const recognizer = createHistorySwipeRecognizer();
    for (const time of [10, 30, 50])
      expect(recognizer.push({ deltaX: -80, deltaY: 0, time, blocked: false })).toBeNull();
    for (const stop of ["cancel", "end"] as const) {
      const { recognizer: active } = swipe([-80, -40]);
      active[stop]();
      expect(active.push({ deltaX: -80, deltaY: 0, time: 60, blocked: false })).toBeNull();
    }
  });
});
