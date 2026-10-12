import type {
  MonitorDisk,
  MonitorMetric,
  MonitorSnapshot,
} from "@bigbud/contracts/system-monitor/types";
import type { HistoryPoint } from "./resourceMonitor.store";
import { appendTransferHistory } from "./resourceMonitor.history";

export type DiskHistory = Record<string, HistoryPoint[]>;

/** Distinguish mount identities without collisions or merging volumes on a shared device. */
export function diskHistoryKey(disk: MonitorDisk): string {
  return JSON.stringify([disk.name, disk.mount, disk.filesystem]);
}

/** Unknown, stale and invalid rates are gaps, never zero activity. */
export function diskRateValue(metric: MonitorMetric | undefined): number | undefined {
  return metric?.status === "ready" && Number.isFinite(metric.value) && metric.value >= 0
    ? metric.value
    : undefined;
}

function sameSample(previous: MonitorMetric | undefined, next: MonitorMetric | undefined): boolean {
  return (
    previous?.sampledAtMs === next?.sampledAtMs &&
    previous?.status === next?.status &&
    previous?.value === next?.value
  );
}

/** Keep at most 300 points per present volume; break histories on stale samples or continuity loss. */
export function nextDiskHistory(
  previous: MonitorSnapshot | null,
  snapshot: MonitorSnapshot,
  history: DiskHistory,
  continuous: boolean,
): DiskHistory {
  if (snapshot.summaryStatus !== "ready") return {};
  const oldDisks = new Map(previous?.disks.map((disk) => [diskHistoryKey(disk), disk]));
  const next: DiskHistory = {};
  for (const disk of snapshot.disks) {
    const key = diskHistoryKey(disk);
    const read = diskRateValue(disk.readBytesPerSecond);
    const written = diskRateValue(disk.writtenBytesPerSecond);
    if (read === undefined && written === undefined) continue;
    const old = oldDisks.get(key);
    const metrics = [disk.readBytesPerSecond, disk.writtenBytesPerSecond];
    const oldMetrics = [old?.readBytesPerSecond, old?.writtenBytesPerSecond];
    const fresh = metrics.every(
      (metric, index) =>
        metric?.status !== "stale" &&
        oldMetrics[index]?.status !== "stale" &&
        (metric === undefined ||
          oldMetrics[index] === undefined ||
          metric.sampledAtMs >= oldMetrics[index]!.sampledAtMs),
    );
    const points = continuous && fresh ? (history[key] ?? []) : [];
    next[key] =
      continuous &&
      fresh &&
      old &&
      metrics.every((metric, index) => sameSample(oldMetrics[index], metric))
        ? points
        : appendTransferHistory(points, read, written, snapshot.sequence);
  }
  return next;
}
