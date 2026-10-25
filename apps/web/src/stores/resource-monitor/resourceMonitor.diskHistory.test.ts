import { describe, expect, it } from "vitest";
import {
  diskMonitorSnapshot,
  diskMetric,
  monitorDisk,
} from "~/components/resource-monitor/ResourceDisks.fixtures";
import { diskHistoryKey, diskRateValue, nextDiskHistory } from "./resourceMonitor.diskHistory";

describe("per-volume disk history", () => {
  const base = diskMonitorSnapshot();
  const disk = base.disks[0]!;
  const key = diskHistoryKey(disk);
  const history = { [key]: [{ sequence: 1, value: 100, sentValue: -200 }] };
  const next = {
    ...base,
    baseline: false,
    sequence: 2,
    disks: [
      {
        ...disk,
        readBytesPerSecond: diskMetric(0, "ready", 2000),
        writtenBytesPerSecond: diskMetric(300, "ready", 2000),
      },
    ],
  };

  it("records measured zero, mirrors writes, and prunes removed volumes", () => {
    expect(nextDiskHistory(base, next, history, true)).toEqual({
      [key]: [...history[key]!, { sequence: 2, value: 0, sentValue: -300 }],
    });
    expect(nextDiskHistory(base, { ...next, disks: [] }, history, true)).toEqual({});
  });
  it("does not manufacture points when slower disk samples repeat", () => {
    const result = nextDiskHistory(base, { ...base, sequence: 2, baseline: false }, history, true);
    expect(result[key]).toBe(history[key]);
  });
  it("keeps one missing direction a gap and clears fully unavailable volumes", () => {
    const withoutRates = { ...disk };
    delete withoutRates.readBytesPerSecond;
    delete withoutRates.writtenBytesPerSecond;
    expect(
      nextDiskHistory(
        base,
        {
          ...next,
          disks: [{ ...next.disks[0]!, writtenBytesPerSecond: diskMetric(0, "unsupported", 2000) }],
        },
        history,
        true,
      )[key]?.at(-1),
    ).toEqual({ sequence: 2, value: 0, sentValue: null });
    expect(
      nextDiskHistory(
        base,
        {
          ...next,
          disks: [withoutRates],
        },
        history,
        true,
      ),
    ).toEqual({});
  });
  it("resets after continuity loss, stale directions, or a backwards rate timestamp", () => {
    expect(nextDiskHistory(base, next, history, false)[key]).toHaveLength(1);
    expect(nextDiskHistory(base, { ...next, summaryStatus: "stale" }, history, true)).toEqual({});
    expect(
      nextDiskHistory(
        base,
        {
          ...next,
          disks: [{ ...next.disks[0]!, writtenBytesPerSecond: diskMetric(0, "stale", 2000) }],
        },
        history,
        true,
      )[key],
    ).toEqual([{ sequence: 2, value: 0, sentValue: null }]);
    expect(
      nextDiskHistory(
        base,
        {
          ...next,
          disks: [{ ...next.disks[0]!, readBytesPerSecond: diskMetric(30, "ready", 500) }],
        },
        history,
        true,
      )[key],
    ).toHaveLength(1);
  });
  it("bounds each history and separates duplicate volume names by mount", () => {
    const points = Array.from({ length: 300 }, (_, sequence) => ({
      sequence,
      value: 0,
      sentValue: 0,
    }));
    expect(nextDiskHistory(base, next, { [key]: points }, true)[key]).toHaveLength(300);
    expect(diskHistoryKey(monitorDisk("Disk", "/one"))).not.toBe(
      diskHistoryKey(monitorDisk("Disk", "/two")),
    );
    expect(diskHistoryKey({ ...disk, filesystem: "hfs" })).not.toBe(key);
  });
  it.each([-1, NaN, Infinity])("rejects invalid rate %s", (value) =>
    expect(diskRateValue(diskMetric(value))).toBeUndefined(),
  );
  it.each(["warming", "stale", "unsupported", "denied", "unavailable"] as const)(
    "rejects %s rates",
    (status) => expect(diskRateValue(diskMetric(100, status))).toBeUndefined(),
  );
});
