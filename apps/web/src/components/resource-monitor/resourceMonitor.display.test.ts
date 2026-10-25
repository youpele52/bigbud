import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { describe, expect, it } from "vitest";

import { displayWidget } from "./resourceMonitor.display";

describe("resource metric precision", () => {
  it("uses reported memory accounting and available/swap footers", () => {
    const metric = (value: number) => ({
      value: value * 1024 ** 3,
      status: "ready",
      sampledAtMs: 1,
    });
    const snapshot = {
      memoryUsedBytes: metric(12),
      memoryTotalBytes: metric(16),
      memoryAvailableBytes: metric(3),
      swapUsedBytes: metric(1),
      swapTotalBytes: metric(2),
    } as unknown as MonitorSnapshot;
    expect(displayWidget(snapshot, "memory").capacityUsage).toEqual({
      usedBytes: 12 * 1024 ** 3,
      totalBytes: 16 * 1024 ** 3,
      footer: ["Available: 3.00 GiB", "Swap: 1.00 GiB used / 2.00 GiB total"],
    });
    expect(displayWidget(null, "memory").capacityUsage?.totalBytes).toBeNull();
  });
  it("formats CPU values and chart samples to two decimal places", () => {
    const snapshot = {
      cpuPercent: { value: 45.9, status: "ready", sampledAtMs: 1 },
      perCorePercent: [],
    } as unknown as MonitorSnapshot;

    const metric = displayWidget(snapshot, "cpu");

    expect(metric.value).toBe("45.90%");
    expect(metric.gaugeValue).toBe(45.9);
    expect(metric.historyValueFormatter?.(48.418731689453125)).toBe("48.42%");
  });
  it.each([Number.NaN, -1, 101])(
    "keeps invalid CPU usage %s unavailable instead of drawing it",
    (value) => {
      const snapshot = {
        cpuPercent: { value, status: "ready", sampledAtMs: 1 },
        perCorePercent: [],
      } as unknown as MonitorSnapshot;
      expect(displayWidget(snapshot, "cpu").gaugeValue).toBeNull();
      expect(displayWidget(null, "cpu").gaugeValue).toBeNull();
    },
  );
});

describe("network resource widget", () => {
  it("shows both transfer rates and selects bidirectional history", () => {
    const snapshot = {
      networkReceivedBytesPerSecond: { value: 1_079_033, status: "ready", sampledAtMs: 1 },
      networkTransmittedBytesPerSecond: { value: 1_069_548, status: "ready", sampledAtMs: 1 },
    } as unknown as MonitorSnapshot;

    expect(displayWidget(snapshot, "network")).toMatchObject({
      value: "↓ 1.03 MiB/s · ↑ 1.02 MiB/s",
      status: "ready",
      historyStyle: "network",
      networkRates: { download: "1.03 MiB/s", upload: "1.02 MiB/s" },
    });
  });

  it("reports the non-ready direction when only one transfer rate is ready", () => {
    const snapshot = {
      networkReceivedBytesPerSecond: { value: 1_024, status: "ready", sampledAtMs: 1 },
      networkTransmittedBytesPerSecond: { value: 0, status: "warming", sampledAtMs: 1 },
    } as unknown as MonitorSnapshot;

    expect(displayWidget(snapshot, "network")).toMatchObject({
      status: "warming",
      networkRates: { download: "1.00 KiB/s", upload: "—" },
    });
  });

  it("keeps both directions labeled before the first snapshot", () => {
    expect(displayWidget(null, "network")).toMatchObject({
      status: "warming",
      networkRates: { download: "—", upload: "—" },
      historyStyle: "network",
    });
  });
});
