import type { MonitorAppGroup, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

function metric(value: number) {
  return { value, status: "ready" as const, sampledAtMs: 1000 };
}

/** Representative core/inclusive totals for component and browser regressions. */
export function appMonitorSnapshot(): MonitorSnapshot {
  const core: MonitorAppGroup = {
    role: "desktop",
    processCount: 12,
    cpuPercent: metric(4.8),
    residentBytes: metric(1024 ** 3),
    readBytesPerSecond: metric(0),
    writtenBytesPerSecond: metric(2048),
  };
  return {
    subscriptionId: 1,
    epoch: 1,
    sequence: 1,
    baseline: true,
    sampledAtMs: 1000,
    hostname: "desktop",
    osName: "Darwin",
    osVersion: "27.0.1",
    architecture: "arm64",
    perCorePercent: [],
    temperaturesCelsius: [],
    disks: [],
    interfaces: [],
    processStatus: "ready",
    summaryStatus: "ready",
    memoryTotalBytes: metric(16 * 1024 ** 3),
    perCoreTruncated: false,
    disksTruncated: false,
    interfacesTruncated: false,
    sensorsTruncated: false,
    appResources: {
      generation: 1,
      sampledAtMs: 1000,
      incomplete: false,
      core,
      inclusive: {
        ...core,
        role: "tools",
        processCount: 20,
        cpuPercent: metric(18.4),
        residentBytes: metric(2 * 1024 ** 3),
      },
      groups: [
        {
          role: "desktop",
          processCount: 10,
          cpuPercent: metric(3.1),
          residentBytes: metric(768 * 1024 ** 2),
        },
        {
          role: "backend",
          processCount: 1,
          cpuPercent: metric(1.4),
          residentBytes: metric(192 * 1024 ** 2),
        },
        {
          role: "native",
          processCount: 1,
          cpuPercent: metric(0.3),
          residentBytes: metric(64 * 1024 ** 2),
        },
        {
          role: "tools",
          processCount: 8,
          cpuPercent: metric(13.6),
          residentBytes: metric(1024 ** 3),
        },
      ],
    },
  };
}
