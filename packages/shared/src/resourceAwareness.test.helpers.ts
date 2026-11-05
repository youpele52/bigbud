import type { MonitorMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

export const ready = (value: number, sampledAtMs: number): MonitorMetric => ({
  value,
  sampledAtMs,
  status: "ready",
});
export function resourceSnapshot(
  sampledAtMs: number,
  patch: Partial<MonitorSnapshot> = {},
): MonitorSnapshot {
  return {
    subscriptionId: 1,
    epoch: 1,
    sequence: sampledAtMs,
    baseline: false,
    sampledAtMs,
    hostname: "desktop",
    osName: "macOS",
    osVersion: "26",
    architecture: "arm64",
    perCorePercent: [],
    disks: [],
    interfaces: [],
    temperaturesCelsius: [],
    perCoreTruncated: false,
    disksTruncated: false,
    sensorsTruncated: false,
    interfacesTruncated: false,
    summaryStatus: "ready",
    processStatus: "ready",
    cpuPercent: ready(96, sampledAtMs),
    memoryTotalBytes: ready(100, sampledAtMs),
    memoryUsedBytes: ready(96, sampledAtMs),
    ...patch,
  };
}
