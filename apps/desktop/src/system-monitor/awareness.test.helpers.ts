import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
export function snapshot(time = Date.now(), patch: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    subscriptionId: 1,
    epoch: 1,
    sequence: time,
    baseline: false,
    sampledAtMs: time,
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
    interfacesTruncated: false,
    sensorsTruncated: false,
    processStatus: "ready",
    summaryStatus: "ready",
    cpuPercent: { value: 96, sampledAtMs: time, status: "ready" },
    ...patch,
  };
}
