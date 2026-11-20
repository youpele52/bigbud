import { describe, expect, it } from "vitest";
import { TerminalRecencyCoalescer } from "./terminalRecencyCoalescer.ts";

describe("TerminalRecencyCoalescer", () => {
  it("writes the first activity at once and folds the rest of the window into one write", () => {
    const coalescer = new TerminalRecencyCoalescer(60_000);
    expect(coalescer.record("t", "a", 0, 0)).toEqual({ threadId: "t", terminalId: "a", atMs: 0 });
    expect(coalescer.record("t", "a", 10_000, 10_000)).toBeNull();
    expect(coalescer.record("t", "b", 30_000, 30_000)).toBeNull();
    expect(coalescer.takeDue(59_999)).toEqual([]);
    expect(coalescer.takeDue(60_000)).toEqual([{ threadId: "t", terminalId: "b", atMs: 30_000 }]);
    // The trailing write opened a new window.
    expect(coalescer.record("t", "a", 61_000, 61_000)).toBeNull();
    expect(coalescer.takeDue(120_000)).toEqual([{ threadId: "t", terminalId: "a", atMs: 61_000 }]);
  });

  it("writes at most once per window under constant activity", () => {
    const coalescer = new TerminalRecencyCoalescer(60_000);
    let writes = 0;
    for (let now = 0; now < 600_000; now += 1_000) {
      if (coalescer.record("t", "a", now, now)) writes++;
      writes += coalescer.takeDue(now).length;
    }
    expect(writes).toBeLessThanOrEqual(10);
    expect(writes).toBeGreaterThanOrEqual(9);
  });

  it("forgets quiet threads and drains pending writes for shutdown", () => {
    const coalescer = new TerminalRecencyCoalescer(60_000);
    coalescer.record("quiet", "a", 0, 0);
    expect(coalescer.takeDue(60_000)).toEqual([]);
    expect(coalescer.record("quiet", "a", 61_000, 61_000)).not.toBeNull();
    coalescer.record("busy", "a", 0, 0);
    coalescer.record("busy", "a", 5_000, 5_000);
    expect(coalescer.drain()).toEqual([{ threadId: "busy", terminalId: "a", atMs: 5_000 }]);
  });
});
