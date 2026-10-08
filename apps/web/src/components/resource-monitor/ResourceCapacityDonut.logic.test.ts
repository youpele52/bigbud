import { describe, expect, it } from "vitest";
import { capacityDonutData } from "./ResourceCapacityDonut.logic";

describe("resource capacity donuts", () => {
  it("compares bigbud against total host capacity, not other processes' utilization", () => {
    expect(capacityDonutData({ used: 4.22, total: 100 })).toMatchObject({
      percentage: 4.22,
      exceedsCapacity: false,
      slices: [
        { name: "Core bigbud", value: 4.22 },
        { name: "Remaining capacity", value: 95.78 },
      ],
    });
    expect(capacityDonutData({ used: 1024 ** 3, total: 16 * 1024 ** 3 })?.percentage).toBe(6.25);
  });

  it.each([0, 100])("retains a real %s percent measurement", (used) => {
    const data = capacityDonutData({ used, total: 100 });
    expect(data?.percentage).toBe(used);
    expect(data?.slices.map((slice) => slice.value)).toEqual([used, 100 - used]);
  });

  it.each([
    undefined,
    { used: -1, total: 100 },
    { used: Number.NaN, total: 100 },
    { used: Infinity, total: 100 },
    { used: 10, total: 0 },
    { used: 10, total: -1 },
    { used: 10, total: Infinity },
  ])("does not invent zero usage from unavailable or invalid capacity: %j", (usage) => {
    expect(capacityDonutData(usage)).toBeUndefined();
  });

  it("keeps an over-capacity memory estimate truthful while bounding the arc", () => {
    expect(capacityDonutData({ used: 20, total: 16 })).toMatchObject({
      percentage: 125,
      exceedsCapacity: true,
      slices: [{ value: 100 }, { value: 0 }],
    });
  });
});
