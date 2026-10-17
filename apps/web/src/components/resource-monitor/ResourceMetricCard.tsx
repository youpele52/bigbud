import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ResourceCapacityUsage } from "./ResourceCapacityUsage";
import { ResourceMetricHistory } from "./ResourceMetricHistory";
import { ResourceNetworkRates, type NetworkRates } from "./ResourceNetworkRates";
import { Gauge } from "../ui/gauge";
import { formatPercent } from "./resourceMonitor.format";
import {
  capacityPercent,
  formatCapacityGiB,
  type CapacityUsage,
} from "./ResourceCapacityUsage.logic";
import { ResourceMemoryUsage } from "./ResourceMemoryUsage";
import { ResourceMemoryReadout } from "./ResourceMemoryReadout";
import { ResourceMetricBadge } from "./ResourceMetricBadge";
import { CenteredStatus } from "../common/CenteredStatus";
import { isLoadingStatus } from "../common/CenteredStatus.logic";

export interface DisplayPoint {
  sequence: number;
  value: number | null;
  sentValue?: number | null;
}

export interface DisplayMetric {
  label: string;
  value: string;
  status: string;
  detail?: string;
  history?: readonly DisplayPoint[];
  historyValueFormatter?: (value: number) => string;
  historyStyle?: "network" | "io" | "temperature";
  capacityUsage?: CapacityUsage;
  networkRates?: NetworkRates;
  gaugeValue?: number | null;
}

export function ResourceMetricCard({
  metric,
  large = false,
  loading = isLoadingStatus(metric.status),
}: {
  metric: DisplayMetric;
  large?: boolean;
  loading?: boolean;
}) {
  const memoryHistory =
    metric.label === "Memory" &&
    metric.capacityUsage &&
    metric.status === "ready" &&
    capacityPercent(metric.capacityUsage) !== null;
  const showHistory = (!metric.capacityUsage || memoryHistory) && (metric.history?.length ?? 0) > 1;
  return (
    <Card className="min-w-0 gap-2 py-3">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 px-4">
        <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
        {metric.label === "Memory" && metric.capacityUsage ? (
          <ResourceMemoryReadout
            used={formatCapacityGiB(metric.capacityUsage.usedBytes)}
            total={formatCapacityGiB(metric.capacityUsage.totalBytes)}
          />
        ) : metric.gaugeValue !== undefined && metric.detail ? (
          <ResourceMetricBadge>{metric.detail}</ResourceMetricBadge>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 px-4">
        {metric.label === "Memory" && metric.capacityUsage ? (
          <ResourceMemoryUsage usage={metric.capacityUsage} />
        ) : metric.capacityUsage ? (
          <ResourceCapacityUsage usage={metric.capacityUsage} label={metric.label} large={large} />
        ) : metric.gaugeValue !== undefined ? (
          <Gauge
            value={metric.gaugeValue}
            label={`CPU usage${metric.gaugeValue === null ? " unavailable" : ""}`}
            formatValue={formatPercent}
            description="of total host CPU"
          />
        ) : metric.networkRates ? (
          <ResourceNetworkRates rates={metric.networkRates} />
        ) : (
          <div className="truncate text-xl font-semibold tabular-nums" title={metric.value}>
            {metric.value}
          </div>
        )}
        {metric.detail && !metric.capacityUsage && metric.gaugeValue === undefined ? (
          <p className="truncate text-xs text-muted-foreground" title={metric.detail}>
            {metric.detail}
          </p>
        ) : null}
        {metric.status !== "ready" ? (
          <CenteredStatus loading={loading} className="capitalize">
            {metric.status.replaceAll("_", " ")}
          </CenteredStatus>
        ) : null}
        {showHistory ? (
          <div className="mt-auto">
            <ResourceMetricHistory metric={metric} large={large} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
