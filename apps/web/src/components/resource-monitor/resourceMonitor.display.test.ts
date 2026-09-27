import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { describe, expect, it } from "vitest";

import { displayWidget } from "./resourceMonitor.display";

describe("Disk resource widget", () => {
  it("shows a named disk when the combined capacity is unavailable", () => {
    const snapshot = {
      diskCapacityBytes: { value: 0, status: "unavailable", sampledAtMs: 1 },
      disks: [
        {
          name: "Macintosh HD",
          totalBytes: { value: 494_384_795_648, status: "ready", sampledAtMs: 1 },
        },
      ],
    } as MonitorSnapshot;

    expect(displayWidget(snapshot, "disk")).toMatchObject({
      value: "460.43 GiB",
      status: "ready",
      detail: "Macintosh HD capacity",
    });
  });

  it("keeps an unavailable state when no disk is reported", () => {
    const snapshot = {
      diskCapacityBytes: { value: 0, status: "unavailable", sampledAtMs: 1 },
      disks: [],
    } as unknown as MonitorSnapshot;

    expect(displayWidget(snapshot, "disk")).toMatchObject({
      value: "—",
      status: "unavailable",
      detail: "Combined capacity",
    });
  });

  it("does not present one of several disks as a combined capacity", () => {
    const snapshot = {
      diskCapacityBytes: { value: 0, status: "unavailable", sampledAtMs: 1 },
      disks: [
        { name: "One", totalBytes: { value: 100, status: "ready", sampledAtMs: 1 } },
        { name: "Two", totalBytes: { value: 200, status: "ready", sampledAtMs: 1 } },
      ],
    } as unknown as MonitorSnapshot;

    expect(displayWidget(snapshot, "disk")).toMatchObject({
      value: "—",
      status: "unavailable",
      detail: "Combined capacity",
    });
  });
});

describe("resource metric precision", () => {
  it("formats CPU values and chart samples to two decimal places", () => {
    const snapshot = {
      cpuPercent: { value: 45.9, status: "ready", sampledAtMs: 1 },
      perCorePercent: [],
    } as unknown as MonitorSnapshot;

    const metric = displayWidget(snapshot, "cpu");

    expect(metric.value).toBe("45.90%");
    expect(metric.historyValueFormatter?.(48.418731689453125)).toBe("48.42%");
  });
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
    });
  });

  it("reports the non-ready direction when only one transfer rate is ready", () => {
    const snapshot = {
      networkReceivedBytesPerSecond: { value: 1_024, status: "ready", sampledAtMs: 1 },
      networkTransmittedBytesPerSecond: { value: 0, status: "warming", sampledAtMs: 1 },
    } as unknown as MonitorSnapshot;

    expect(displayWidget(snapshot, "network").status).toBe("warming");
  });
});
