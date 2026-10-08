import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import type { HistoryPoint } from "./resourceMonitor.store";

export interface AppHistory {
  cpu: HistoryPoint[];
  memory: HistoryPoint[];
}
export const EMPTY_APP_HISTORY: AppHistory = { cpu: [], memory: [] };

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
    if (metric?.status !== "ready" || !Number.isFinite(metric.value)) return [];
    return [...points.slice(-299), { sequence: snapshot.sequence, value: metric.value }];
  };
  return {
    cpu: append(next.cpu, app.core.cpuPercent),
    memory: append(next.memory, app.core.residentBytes),
  };
}
