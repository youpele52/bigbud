import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { describe, expect, it } from "vitest";

import { displayWidget } from "./resourceMonitor.display";

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
