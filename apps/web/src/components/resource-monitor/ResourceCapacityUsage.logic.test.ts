import { describe, expect, it } from "vitest";
import {
  capacityPercent,
  capacitySeverity,
  formatCapacityGiB,
} from "./ResourceCapacityUsage.logic";

describe("capacity usage", () => {
  it.each([
    [0, "neutral"],
    [79.999, "neutral"],
    [80, "warning"],
    [94.999, "warning"],
    [95, "critical"],
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
});
