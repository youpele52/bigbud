import { describe, expect, it } from "vitest";
import { createHistorySwipeRecognizer } from "./browserHistoryGestures.logic";

function swipe(deltas: number[], vertical = 0) {
  const recognizer = createHistorySwipeRecognizer();
  recognizer.begin();
  deltas.forEach((deltaX, index) =>
    recognizer.push({ deltaX, deltaY: vertical, time: 10 + index * 20, blocked: false }),
  );
  return recognizer;
}

describe("browser history swipe recognition", () => {
  it.each([
    [[-60, -60, -60], "back"],
    [[60, 60, 60], "forward"],
  ] as const)("commits %j once, only at gesture end", (deltas, direction) => {
    const recognizer = swipe([...deltas]);
    expect(recognizer.isActive()).toBe(true);
    expect(recognizer.end(80)).toBe(direction);
    expect(recognizer.end(90)).toBeNull();
    recognizer.push({ deltaX: 500, deltaY: 0, time: 100, blocked: false });
    expect(recognizer.end(110)).toBeNull();
    recognizer.begin();
    for (const time of [120, 140, 160])
      recognizer.push({ deltaX: 60, deltaY: 0, time, blocked: false });
    expect(recognizer.end(180)).toBe("forward");
  });

  it.each([
    [[10, 10, 10], 0],
    [[200], 0],
    [[0, 0, -200], 0],
    [[100, 100], 0],
    [[60, 60, 60], 30],
    [[0, 0, 0], 60],
    [[-60, -60, -60, 30, -60], 0],
    [[60, -10, -10, -10, 200], 0],
  ] as const)(
    "rejects small, impulsive, diagonal, vertical or reversed movement: %j/%s",
    (deltas, vertical) => {
      expect(swipe([...deltas], vertical).end(120)).toBeNull();
    },
  );

  it("locks out a gesture that ever touches a scroller or site-owned surface", () => {
    const recognizer = swipe([80, 80]);
    recognizer.push({ deltaX: 60, deltaY: 0, time: 60, blocked: true });
    recognizer.push({ deltaX: 200, deltaY: 0, time: 80, blocked: false });
    expect(recognizer.end(100)).toBeNull();
  });

  it("rejects slow accumulation, pauses, invalid deltas and stale ends", () => {
    const recognizer = swipe([60, 60, 60]);
    expect(recognizer.end(1000)).toBeNull();
    for (const sample of [
      { deltaX: 200, deltaY: 0, time: 300, blocked: false },
      { deltaX: NaN, deltaY: 0, time: 60, blocked: false },
      { deltaX: 200, deltaY: Infinity, time: 60, blocked: false },
      { deltaX: 200, deltaY: 0, time: 5, blocked: false },
    ]) {
      const next = swipe([80, 80]);
      next.push(sample);
      expect(next.end(100)).toBeNull();
    }
  });

  it("requires an explicit begin and respects cancellation", () => {
    const recognizer = createHistorySwipeRecognizer();
    for (const time of [10, 30, 50])
      recognizer.push({ deltaX: -80, deltaY: 0, time, blocked: false });
    expect(recognizer.end(60)).toBeNull();
    const active = swipe([-80, -80, -80]);
    active.cancel();
    expect(active.end(60)).toBeNull();
  });
});
