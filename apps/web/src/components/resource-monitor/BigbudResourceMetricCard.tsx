import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import type { CapacityUsage } from "./ResourceCapacityDonut.logic";
import type { DisplayMetric } from "./ResourceMetricCard";
import { ResourceMetricHistory } from "./ResourceMetricHistory";
import { ResourceCapacityGauge } from "./ResourceCapacityGauge";
import { ResourceMemoryReadout } from "./ResourceMemoryReadout";
import { ResourceMetricBadge } from "./ResourceMetricBadge";
import { CenteredStatus } from "../common/CenteredStatus";
import { isLoadingStatus } from "../common/CenteredStatus.logic";

export function BigbudResourceMetricCard({
  metric,
  kind,
  capacity,
  large = false,
  memoryTotal = "—",
  processCount,
}: {
  metric: DisplayMetric;
  kind: "cpu" | "memory";
  capacity: CapacityUsage | undefined;
  large?: boolean;
  memoryTotal?: string;
  processCount?: number | undefined;
}) {
  return (
    <Card className="min-w-0 gap-2 py-3">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4">
        <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
        {kind === "memory" ? (
          <ResourceMemoryReadout used={metric.value} total={memoryTotal} estimated />
        ) : (
          <ResourceMetricBadge>{processCount ?? "—"} core processes</ResourceMetricBadge>
        )}
      </CardHeader>
      <CardContent className="grid min-w-0 items-center gap-4 px-4">
        <ResourceCapacityGauge usage={capacity} kind={kind} />
        <div className="min-w-0 space-y-2">
          {metric.status !== "ready" && (metric.history?.length ?? 0) > 1 ? (
            <CenteredStatus loading={isLoadingStatus(metric.status)} className="capitalize">
              {metric.status.replaceAll("_", " ")}
            </CenteredStatus>
          ) : null}
          {(metric.history?.length ?? 0) > 1 ? (
            <ResourceMetricHistory metric={metric} large={large} />
          ) : (
            <CenteredStatus
              loading={metric.status === "ready" || isLoadingStatus(metric.status)}
              className={`${large ? "h-28" : "h-12"} capitalize`}
            >
              {metric.status === "ready"
                ? "Waiting for history"
                : isLoadingStatus(metric.status)
                  ? metric.status.replaceAll("_", " ")
                  : "Measurements unavailable"}
            </CenteredStatus>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
