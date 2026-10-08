import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ResourceCapacityDonut } from "./ResourceCapacityDonut";
import type { CapacityUsage } from "./ResourceCapacityDonut.logic";
import type { DisplayMetric } from "./ResourceMetricCard";
import { ResourceMetricHistory } from "./ResourceMetricHistory";

export function BigbudResourceMetricCard({
  metric,
  kind,
  capacity,
  large = false,
}: {
  metric: DisplayMetric;
  kind: "cpu" | "memory";
  capacity: CapacityUsage | undefined;
  large?: boolean;
}) {
  return (
    <Card className="min-w-0 gap-2 py-3">
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-4">
        <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
        {kind === "memory" ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {metric.value} · estimated
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="grid min-w-0 items-center gap-4 px-4">
        <ResourceCapacityDonut usage={capacity} kind={kind} />
        <div className="min-w-0 space-y-2">
          {metric.status !== "ready" ? (
            <p className="text-xs capitalize text-muted-foreground">
              {metric.status.replaceAll("_", " ")}
            </p>
          ) : null}
          {(metric.history?.length ?? 0) > 1 ? (
            <ResourceMetricHistory metric={metric} large={large} />
          ) : (
            <div
              className={`flex items-center justify-center text-xs text-muted-foreground ${large ? "h-28" : "h-12"}`}
            >
              Waiting for history…
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
