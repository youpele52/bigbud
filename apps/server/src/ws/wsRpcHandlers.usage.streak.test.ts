import { describe, expect, it } from "vitest";
import { computeCurrentStreakDays } from "./wsRpcHandlers.usage.streak.ts";

describe("current UTC usage streak", () => {
  it.each([
    [[], "2026-10-11T00:00:00Z", 0],
    [["2026-10-10"], "2026-10-11T00:00:00Z", 0],
    [["2026-10-11", "2026-10-11", "2026-10-10", "2026-10-08"], "2026-10-11T23:59:59.999Z", 2],
    [["2026-10-11", "2026-10-10"], "2026-10-12T00:00:00Z", 0],
    [["2027-01-01", "2026-12-31", "2026-12-30"], "2027-01-01T00:00:00Z", 3],
    [["2024-03-01", "2024-02-29", "2024-02-28"], "2024-03-01T12:00:00Z", 3],
    [["2026-10-12", "2026-10-11"], "2026-10-11T12:00:00Z", 1],
    [["2026-10-11", "2026-10-10"], "2026-10-10T23:30:00-01:00", 2],
  ] as const)("counts days %s at %s as %s", (days, now, expected) => {
    expect(computeCurrentStreakDays(days, new Date(now))).toBe(expected);
  });
});
