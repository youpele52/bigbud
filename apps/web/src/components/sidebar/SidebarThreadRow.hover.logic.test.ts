import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalActivityHoverLine, threadHoverSummary } from "./SidebarThreadRow.hover.logic";

describe("thread hover card lines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("shows the last terminal activity with or without an elevator summary", () => {
    expect(terminalActivityHoverLine("2026-01-01T10:00:00.000Z")).toEqual({
      label: "Last terminal activity",
      time: "2h",
    });
    expect(terminalActivityHoverLine(new Date().toISOString())).toEqual({
      label: "Last terminal activity",
      time: "just now",
    });
    expect(terminalActivityHoverLine(null)).toBeNull();
    expect(terminalActivityHoverLine("not a date")).toBeNull();
  });

  it("omits an elevator summary that only repeats the title", () => {
    expect(threadHoverSummary({ title: "Fix build", elevatorSummary: "Fix  build" })).toBeNull();
    expect(threadHoverSummary({ title: "Fix build", elevatorSummary: "Fixed CI" })).toBe(
      "Fixed CI",
    );
  });
});
