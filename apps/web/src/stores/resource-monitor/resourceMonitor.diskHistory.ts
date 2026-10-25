import type {
  MonitorDisk,
  MonitorMetric,
  MonitorSnapshot,
} from "@bigbud/contracts/system-monitor/types";
import { readyTransferValue } from "./resourceMonitor.history";
import {
  nextEntityTransferHistory,
  type EntityTransferHistory,
} from "./resourceMonitor.entityHistory";

export type DiskHistory = EntityTransferHistory;

/** Distinguish mount identities without collisions or merging volumes on a shared device. */
export function diskHistoryKey(disk: MonitorDisk): string {
  return JSON.stringify([disk.name, disk.mount, disk.filesystem]);
}

/** Unknown, stale and invalid rates are gaps, never zero activity. */
export function diskRateValue(metric: MonitorMetric | undefined): number | undefined {
  return readyTransferValue(metric);
}

/** Keep at most 300 points per present volume; break histories on stale samples or continuity loss. */
export function nextDiskHistory(
  previous: MonitorSnapshot | null,
  snapshot: MonitorSnapshot,
  history: DiskHistory,
  continuous: boolean,
): DiskHistory {
  if (snapshot.summaryStatus !== "ready") return {};
  const entities = (disks: readonly MonitorDisk[]) =>
    disks.map((disk) => ({
      key: diskHistoryKey(disk),
      incoming: disk.readBytesPerSecond,
      outgoing: disk.writtenBytesPerSecond,
    }));
  return nextEntityTransferHistory(
    entities(previous?.disks ?? []),
    entities(snapshot.disks),
    history,
    snapshot.sequence,
    continuous,
  );
}
