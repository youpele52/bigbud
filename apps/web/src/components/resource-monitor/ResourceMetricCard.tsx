import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ResourceDiskUsage, type DiskUsage } from "./ResourceDiskUsage";
import { ResourceMetricHistory } from "./ResourceMetricHistory";

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
  diskUsage?: DiskUsage;
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
        {metric.diskUsage ? (
          <ResourceDiskUsage
            usage={metric.diskUsage}
            {...(metric.detail ? { detail: metric.detail } : {})}
          />
        ) : (
          <div className="truncate text-xl font-semibold tabular-nums" title={metric.value}>
            {metric.value}
          </div>
        )}
        {metric.detail && !metric.diskUsage ? (
          <p className="truncate text-xs text-muted-foreground" title={metric.detail}>
            {metric.detail}
          </p>
        ) : null}
        {metric.status !== "ready" ? (
          <p className="text-xs capitalize text-muted-foreground">
            {metric.status.replaceAll("_", " ")}
          </p>
        ) : null}
        <ResourceMetricHistory metric={metric} large={large} />
      </CardContent>
    </Card>
  );
}
