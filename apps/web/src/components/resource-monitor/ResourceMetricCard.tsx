import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ResourceCapacityUsage } from "./ResourceCapacityUsage";
import type { CapacityUsage } from "./ResourceCapacityUsage.logic";
import { ResourceMetricHistory } from "./ResourceMetricHistory";
import { ResourceNetworkRates, type NetworkRates } from "./ResourceNetworkRates";

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
  historyStyle?: "network";
  capacityUsage?: CapacityUsage;
  networkRates?: NetworkRates;
}

export function ResourceMetricCard({
  metric,
  large = false,
}: {
  metric: DisplayMetric;
  large?: boolean;
}) {
  return (
    <Card className="min-w-0 gap-2 py-3">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        {metric.capacityUsage ? (
          <ResourceCapacityUsage usage={metric.capacityUsage} label={metric.label} large={large} />
        ) : metric.networkRates ? (
          <ResourceNetworkRates rates={metric.networkRates} />
        ) : (
          <div className="truncate text-xl font-semibold tabular-nums" title={metric.value}>
            {metric.value}
          </div>
        )}
        {metric.detail && !metric.capacityUsage ? (
          <p className="truncate text-xs text-muted-foreground" title={metric.detail}>
            {metric.detail}
          </p>
        ) : null}
        {metric.status !== "ready" ? (
          <p className="text-xs capitalize text-muted-foreground">
            {metric.status.replaceAll("_", " ")}
          </p>
        ) : null}
        {!metric.capacityUsage ? <ResourceMetricHistory metric={metric} large={large} /> : null}
      </CardContent>
    </Card>
  );
}
