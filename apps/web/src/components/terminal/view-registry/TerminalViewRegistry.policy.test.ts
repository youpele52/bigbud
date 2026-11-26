import { describe, expect, it } from "vitest";
import {
  nextTerminalViewParkCheck,
  selectTerminalViewsToEvict,
  selectTerminalViewsToPark,
  selectWarmTerminalViews,
  TERMINAL_VIEW_PARK_DELAY_MS,
  TERMINAL_VIEW_WARM_MAX_VIEWS,
  terminalViewState,
  type TerminalViewPolicyEntry,
} from "./TerminalViewRegistry.policy";

const view = (
  key: string,
  overrides: Partial<TerminalViewPolicyEntry> = {},
): TerminalViewPolicyEntry => ({
  key,
  surfaceKey: key,
  attached: false,
  mounted: true,
  restorable: true,
  lastAttachedAt: 0,
  releasedAt: 0,
  ...overrides,
});

describe("terminal view parking policy", () => {
  it("keeps the 4 most recently attached surfaces warm, counting the attached one", () => {
    const entries = [
      view("attached", { attached: true, releasedAt: null, lastAttachedAt: 1 }),
      view("s1", { lastAttachedAt: 50 }),
      view("s2", { lastAttachedAt: 40 }),
      view("s3", { lastAttachedAt: 30 }),
      view("s4", { lastAttachedAt: 20 }),
    ];
    expect([...selectWarmTerminalViews(entries)].toSorted()).toEqual([
      "attached",
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("parks only after the 30 s delay, and only views outside the warm set", () => {
    const entries = [
      view("attached", { attached: true, releasedAt: null, lastAttachedAt: 100 }),
      view("s1", { lastAttachedAt: 50, releasedAt: 50 }),
      view("s2", { lastAttachedAt: 40, releasedAt: 40 }),
      view("s3", { lastAttachedAt: 30, releasedAt: 30 }),
      view("cold", { lastAttachedAt: 20, releasedAt: 20 }),
    ];
    expect(selectTerminalViewsToPark(entries, 20 + TERMINAL_VIEW_PARK_DELAY_MS - 1)).toEqual([]);
    expect(selectTerminalViewsToPark(entries, 20 + TERMINAL_VIEW_PARK_DELAY_MS)).toEqual(["cold"]);
  });

  it("never parks attached, unrestorable or already parked views", () => {
    const now = 10 * TERMINAL_VIEW_PARK_DELAY_MS;
    const warmers = [1, 2, 3, 4].map((index) =>
      view(`warm-${index}`, { attached: true, releasedAt: null, lastAttachedAt: now }),
    );
    const entries = [
      ...warmers,
      view("unrestorable", { restorable: false }),
      view("parked", { mounted: false }),
      view("restorable"),
    ];
    expect(selectTerminalViewsToPark(entries, now)).toEqual(["restorable"]);
  });

  it("caps warm views at 12 across warm surfaces, newest first", () => {
    const entries = Array.from({ length: TERMINAL_VIEW_WARM_MAX_VIEWS + 2 }, (_, index) =>
      view(`pane-${index}`, { surfaceKey: "one-thread", lastAttachedAt: index }),
    );
    const warm = selectWarmTerminalViews(entries);
    expect(warm.size).toBe(TERMINAL_VIEW_WARM_MAX_VIEWS);
    expect(warm.has("pane-0")).toBe(false);
    expect(warm.has("pane-1")).toBe(false);
    expect(selectTerminalViewsToPark(entries, TERMINAL_VIEW_PARK_DELAY_MS)).toEqual([
      "pane-0",
      "pane-1",
    ]);
  });

  it("schedules the next check at the earliest pending delay", () => {
    const entries = [
      view("a", { releasedAt: 1_000 }),
      view("b", { releasedAt: 5_000 }),
      view("attached", { attached: true, releasedAt: null }),
      view("unrestorable", { restorable: false, releasedAt: 0 }),
    ];
    expect(nextTerminalViewParkCheck(entries, 2_000)).toBe(1_000 + TERMINAL_VIEW_PARK_DELAY_MS);
    expect(nextTerminalViewParkCheck(entries, 1_000 + TERMINAL_VIEW_PARK_DELAY_MS)).toBe(
      5_000 + TERMINAL_VIEW_PARK_DELAY_MS,
    );
    expect(nextTerminalViewParkCheck([entries[3]!], 0)).toBeNull();
  });

  it("names the view state", () => {
    expect(terminalViewState(view("a", { attached: true }))).toBe("attached");
    expect(terminalViewState(view("a"))).toBe("warm");
    expect(terminalViewState(view("a", { mounted: false }))).toBe("parked");
  });

  it("caps 20 released unrestorable views at 12 and never evicts an attached one", () => {
    const entries = [
      ...Array.from({ length: 20 }, (_, index) =>
        view(`released-${index}`, { restorable: false, lastAttachedAt: index + 10 }),
      ),
      view("attached-old", { attached: true, releasedAt: null, lastAttachedAt: 0 }),
    ];
    const evicted = selectTerminalViewsToEvict(entries);
    expect(entries.length - evicted.length).toBe(TERMINAL_VIEW_WARM_MAX_VIEWS);
    expect(evicted).not.toContain("attached-old");
    // Least recently used first.
    expect(evicted).toEqual(Array.from({ length: 9 }, (_, index) => `released-${index}`));
    expect(selectTerminalViewsToEvict(entries.slice(0, 12))).toEqual([]);
  });

  it("leaves restorable views to the park policy", () => {
    const entries = Array.from({ length: 14 }, (_, index) => view(`restorable-${index}`));
    expect(selectTerminalViewsToEvict(entries)).toEqual([]);
  });
});
