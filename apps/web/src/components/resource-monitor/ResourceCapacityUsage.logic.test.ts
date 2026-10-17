import { describe, expect, it } from "vitest";
import {
  capacityPercent,
  capacitySeverity,
  formatCapacityGiB,
} from "./ResourceCapacityUsage.logic";
import { usagePercentColor } from "../ui/usageBands.logic";

describe("capacity usage", () => {
  it.each([
    [0, "var(--chart-1)"],
    [49.999, "var(--chart-1)"],
    [50, "var(--chart-3)"],
    [79.999, "var(--chart-3)"],
    [80, "var(--chart-4)"],
    [100, "var(--chart-4)"],
    [null, "var(--muted-foreground)"],
  ] as const)("shares the expected usage fill at %s%%", (percent, color) => {
    expect(usagePercentColor(percent)).toBe(color);
  });
  it.each([
    [0, "neutral"],
    [49.999, "neutral"],
    [50, "warning"],
    [79.999, "warning"],
    [80, "critical"],
    [95.62, "critical"],
    [100, "critical"],
    [null, "unknown"],
  ] as const)("classifies %s as %s", (percent, expected) => {
    expect(capacitySeverity(percent)).toBe(expected);
  });
  it.each([
    { usedBytes: null, totalBytes: 10 },
    { usedBytes: 1, totalBytes: null },
    { usedBytes: 0, totalBytes: 0 },
    { usedBytes: 11, totalBytes: 10 },
    { usedBytes: -1, totalBytes: 10 },
    { usedBytes: NaN, totalBytes: 10 },
    { usedBytes: 1, totalBytes: Infinity },
  ])("rejects missing and invalid totals %s", (usage) => {
    expect(capacityPercent(usage)).toBeNull();
  });
  it("preserves genuine zero usage and formats explicit GiB", () => {
    expect(capacityPercent({ usedBytes: 0, totalBytes: 10 })).toBe(0);
    expect(formatCapacityGiB(0)).toBe("0.00 GiB");
    expect(formatCapacityGiB(1024 ** 3)).toBe("1.00 GiB");
    expect(formatCapacityGiB(null)).toBe("—");
  });
  it("allows over-capacity estimates explicitly, but never changes the Disk default", () => {
    const usage = { usedBytes: 125, totalBytes: 100 };
    expect(capacityPercent(usage)).toBeNull();
    expect(capacityPercent(usage, true)).toBe(125);
    expect(
      capacityPercent({ usedBytes: Number.MAX_VALUE, totalBytes: Number.MIN_VALUE }, true),
    ).toBeNull();
  });
});
