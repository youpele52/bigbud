import type {
  MonitorAppGroup,
  MonitorMetric,
  MonitorSnapshot,
} from "@bigbud/contracts/system-monitor/types";
import type { DisplayMetric } from "./ResourceMetricCard";
import type { CapacityUsage } from "./ResourceCapacityDonut.logic";
import { formatBytes, formatPercent } from "./resourceMonitor.format";

export const APP_GROUP_LABELS = {
  desktop: "Desktop",
  backend: "Backend",
  native: "Native services",
  tools: "Agents/tools",
} as const;

export function appMetricValue(
  metric: MonitorMetric | undefined,
  format: (value: number) => string,
): string {
  return metric?.status === "ready" && Number.isFinite(metric.value) ? format(metric.value) : "—";
}

export function appCard(
  group: MonitorAppGroup | undefined,
  kind: "cpu" | "memory",
  memoryTotal?: MonitorMetric,
): DisplayMetric & { capacity: CapacityUsage | undefined } {
  const metric = kind === "cpu" ? group?.cpuPercent : group?.residentBytes;
  const format = kind === "cpu" ? formatPercent : formatBytes;
  const total =
    kind === "cpu" ? 100 : memoryTotal?.status === "ready" ? memoryTotal.value : undefined;
  const capacity =
    metric?.status === "ready" &&
    Number.isFinite(metric.value) &&
    metric.value >= 0 &&
    total !== undefined &&
    Number.isFinite(total) &&
    total > 0 &&
    (kind !== "cpu" || metric.value <= total)
      ? { used: metric.value, total }
      : undefined;
  return {
    capacity,
    label: kind === "cpu" ? "CPU" : "Memory",
    value: appMetricValue(metric, format),
    status: metric?.status ?? "warming",
    detail:
      kind === "cpu" ? "Share of total host CPU capacity" : "Summed resident memory · estimated",
    historyValueFormatter: format,
  };
}

export function currentAppResources(snapshot: MonitorSnapshot | null, connected: boolean) {
  const app = snapshot?.appResources;
  if (
    !connected ||
    snapshot?.summaryStatus !== "ready" ||
    !app ||
    snapshot.sampledAtMs - app.sampledAtMs > 10_000
  )
    return undefined;
  return app;
}
