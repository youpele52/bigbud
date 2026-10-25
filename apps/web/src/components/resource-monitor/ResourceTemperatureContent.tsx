import type { MonitorMetric, MonitorNamedMetric } from "@bigbud/contracts/system-monitor/types";
import type { ReactNode } from "react";
import type { HistoryPoint } from "~/stores/resource-monitor/resourceMonitor.store";
import { readyTemperatureValue } from "~/stores/resource-monitor/resourceMonitor.temperature";
import { cn } from "~/lib/utils";
import { CenteredStatus } from "../common/CenteredStatus";
import { isLoadingStatus } from "../common/CenteredStatus.logic";
import { ResourceMetricHistory } from "./ResourceMetricHistory";
import { formatTemperature } from "./resourceMonitor.format";

/** Keep native names and exact readings; only a measured critical threshold can mark danger. */
export function ResourceTemperatureContent({
  sensor,
  critical,
  history,
  current,
  loading,
  expanded = false,
  headerAction,
}: {
  sensor: MonitorNamedMetric;
  critical: MonitorMetric | undefined;
  history: HistoryPoint[];
  current: boolean;
  loading: boolean;
  expanded?: boolean;
  headerAction?: ReactNode;
}) {
  const value = current ? readyTemperatureValue(sensor.metric) : undefined;
  const threshold = current ? readyTemperatureValue(critical) : undefined;
  const criticalReached = value !== undefined && threshold !== undefined && value >= threshold;
  const waiting = loading || (current && isLoadingStatus(sensor.metric.status));
  const status =
    !current || (sensor.metric.status === "ready" && value === undefined)
      ? "unavailable"
      : sensor.metric.status;
  return (
    <section
      role="region"
      aria-label={`${sensor.name}${expanded ? " expanded" : ""} temperature sensor`}
      className={cn(
        "min-w-0 space-y-3",
        !expanded && "rounded-xl border border-border/60 bg-background/30 p-3",
      )}
    >
      <div className={cn("flex min-w-0 items-center justify-between gap-2", expanded && "pr-8")}>
        <h3 className="min-w-0 break-words text-sm font-medium" title={sensor.name}>
          {sensor.name}
        </h3>
        <div className="flex shrink-0 items-center gap-2">
          <p
            className={cn(
              "text-sm font-semibold tabular-nums",
              criticalReached && "text-destructive",
            )}
            aria-label={`${formatTemperature(value)}${criticalReached ? ", critical threshold reached" : ""}`}
            title={
              criticalReached
                ? `Critical threshold reached: ${formatTemperature(threshold)}`
                : undefined
            }
          >
            {formatTemperature(value)}
          </p>
          {headerAction}
        </div>
      </div>
      <div className={expanded ? "h-64" : "h-12"} data-slot="temperature-history">
        {value !== undefined && history.length > 1 ? (
          <ResourceMetricHistory
            fill
            large={expanded}
            metric={{
              label: `${sensor.name} temperature`,
              value: "",
              status: "ready",
              history,
              historyStyle: "temperature",
              historyValueFormatter: formatTemperature,
            }}
          />
        ) : (
          <CenteredStatus
            className="h-full"
            loading={waiting || (value !== undefined && history.length <= 1)}
          >
            {waiting
              ? "Waiting for sensor data"
              : value !== undefined
                ? "Waiting for sensor history"
                : "Temperature unavailable"}
          </CenteredStatus>
        )}
      </div>
      {expanded ? (
        <div className="space-y-3 border-t border-border/60 pt-3">
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-muted-foreground">Reading status</dt>
              <dd>{status}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Critical threshold</dt>
              <dd className="tabular-nums">
                {threshold !== undefined ? formatTemperature(threshold) : "Unavailable"}
              </dd>
            </div>
          </dl>
          {criticalReached ? (
            <p className="text-xs text-destructive">Reported critical threshold reached</p>
          ) : null}
          <p className="text-xs text-muted-foreground">History uses this sensor’s own °C scale.</p>
        </div>
      ) : null}
    </section>
  );
}
