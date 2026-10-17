import type { MonitorMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import type { HistoryPoint } from "./resourceMonitor.store";
import { appendTransferHistory } from "./resourceMonitor.history";

export interface AppHistory {
  cpu: HistoryPoint[];
  memory: HistoryPoint[];
  io: HistoryPoint[];
  inclusiveCpu: HistoryPoint[];
  inclusiveMemory: HistoryPoint[];
}
export const EMPTY_APP_HISTORY: AppHistory = {
  cpu: [],
  memory: [],
  io: [],
  inclusiveCpu: [],
  inclusiveMemory: [],
};

function readyValue(metric: MonitorMetric | undefined): number | undefined {
  return metric?.status === "ready" && Number.isFinite(metric.value) ? metric.value : undefined;
}

/** Append each five-second app sample once, breaking continuity on ownership or transport changes. */
export function nextAppHistory(
  previous: MonitorSnapshot | null,
  snapshot: MonitorSnapshot,
  history: AppHistory,
  continuous: boolean,
): AppHistory {
  const app = snapshot.appResources;
  if (
    !app ||
    app.incomplete ||
    snapshot.summaryStatus !== "ready" ||
    snapshot.sampledAtMs - app.sampledAtMs > 10_000
  )
    return EMPTY_APP_HISTORY;
  const old = previous?.appResources;
  const next = continuous && old?.generation === app.generation ? history : EMPTY_APP_HISTORY;
  if (continuous && old?.generation === app.generation && old.sampledAtMs === app.sampledAtMs)
    return next;
  const append = (points: HistoryPoint[], metric: typeof app.core.cpuPercent) => {
    const value = readyValue(metric);
    if (value === undefined) return [];
    return [...points.slice(-299), { sequence: snapshot.sequence, value }];
  };
  const read = readyValue(app.core.readBytesPerSecond);
  const written = readyValue(app.core.writtenBytesPerSecond);
  return {
    cpu: append(next.cpu, app.core.cpuPercent),
    memory: append(next.memory, app.core.residentBytes),
    inclusiveCpu: append(next.inclusiveCpu, app.inclusive.cpuPercent),
    inclusiveMemory: append(next.inclusiveMemory, app.inclusive.residentBytes),
    io:
      read === undefined && written === undefined
        ? []
        : appendTransferHistory(next.io, read, written, snapshot.sequence),
  };
}
