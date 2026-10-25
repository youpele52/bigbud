import type { MonitorDisk, MonitorMetric } from "@bigbud/contracts/system-monitor/types";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";
import {
  diskHistoryKey,
  type DiskHistory,
} from "~/stores/resource-monitor/resourceMonitor.diskHistory";

export function diskMetric(
  value: number,
  status: MonitorMetric["status"] = "ready",
  sampledAtMs = 1000,
): MonitorMetric {
  return { value, status, sampledAtMs };
}

export function monitorDisk(name = "Macintosh HD", mount = "/"): MonitorDisk {
  return {
    name,
    mount,
    filesystem: "apfs",
    totalBytes: diskMetric(512 * 1024 ** 3),
    freeBytes: diskMetric(16 * 1024 ** 3),
    usedBytes: diskMetric(496 * 1024 ** 3),
    readBytesPerSecond: diskMetric(6 * 1024),
    writtenBytesPerSecond: diskMetric(18 * 1024),
    removable: { value: false, status: "ready", sampledAtMs: 1000 },
    readOnly: { value: true, status: "ready", sampledAtMs: 1000 },
  };
}

export function diskMonitorSnapshot() {
  return {
    ...appMonitorSnapshot(),
    disks: [
      monitorDisk(),
      {
        ...monitorDisk("Helium", "/Volumes/Helium"),
        filesystem: "hfs",
        totalBytes: diskMetric(336.28 * 1024 ** 2),
        usedBytes: diskMetric(336.28 * 1024 ** 2),
        freeBytes: diskMetric(0),
      },
    ],
  };
}

export function diskMonitorHistory(): DiskHistory {
  return Object.fromEntries(
    diskMonitorSnapshot().disks.map((disk) => [
      diskHistoryKey(disk),
      Array.from({ length: 20 }, (_, sequence) => ({
        sequence,
        value: (6 + sequence / 5) * 1024,
        sentValue: -(18 + sequence / 3) * 1024,
      })),
    ]),
  );
}
