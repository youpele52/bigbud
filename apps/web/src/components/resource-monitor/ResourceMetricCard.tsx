import { Area, AreaChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ChartTooltip, ChartTooltipContent } from "../ui/chart";

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
}

export function formatHistoryTooltipValue(
  value: unknown,
  formatter: DisplayMetric["historyValueFormatter"],
  absolute = false,
): string {
  if (value === null || value === undefined) return "—";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "—";
  const displayValue = absolute ? Math.abs(numeric) : numeric;
  return formatter?.(displayValue) ?? displayValue.toFixed(2);
}

function networkDomain(history: readonly DisplayPoint[] | undefined): [number, number] {
  const extent = history?.reduce(
    (largest, point) =>
      Math.max(largest, Math.abs(point.value ?? 0), Math.abs(point.sentValue ?? 0)),
    0,
  );
  const limit = extent && extent > 0 ? extent : 1;
  return [-limit, limit];
}

export function ResourceMetricCard({
  metric,
  large = false,
}: {
  metric: DisplayMetric;
  large?: boolean;
}) {
  const hasHistory = (metric.history?.length ?? 0) > 1;
  return (
    <Card className="min-w-0 gap-2 py-3">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        <div className="truncate text-xl font-semibold tabular-nums" title={metric.value}>
          {metric.value}
        </div>
        {metric.detail ? (
          <p className="truncate text-xs text-muted-foreground" title={metric.detail}>
            {metric.detail}
          </p>
        ) : null}
        {metric.status !== "ready" ? (
          <p className="text-xs capitalize text-muted-foreground">
            {metric.status.replaceAll("_", " ")}
          </p>
        ) : null}
        {hasHistory ? (
          <div
            className={large ? "h-28" : "h-12"}
            role="img"
            aria-label={`${metric.label} history`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={metric.history as DisplayPoint[]}>
                <XAxis dataKey="sequence" hide />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      valueFormatter={(value, name) =>
                        formatHistoryTooltipValue(
                          value,
                          metric.historyValueFormatter,
                          metric.historyStyle === "network" && name === "Sent",
                        )
                      }
                    />
                  }
                />
                {metric.historyStyle === "network" ? (
                  <>
                    <YAxis domain={networkDomain(metric.history)} hide />
                    <ReferenceLine y={0} stroke="var(--border)" />
                    <Area
                      type="monotone"
                      dataKey="value"
                      name="Received"
                      baseValue={0}
                      stroke="var(--chart-2)"
                      fill="var(--chart-2)"
                      fillOpacity={0.16}
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="sentValue"
                      name="Sent"
                      baseValue={0}
                      stroke="var(--chart-4)"
                      fill="var(--chart-4)"
                      fillOpacity={0.16}
                      isAnimationActive={false}
                    />
                  </>
                ) : (
                  <Area
                    type="monotone"
                    dataKey="value"
                    name={metric.label}
                    stroke="var(--chart-1)"
                    fill="var(--chart-1)"
                    fillOpacity={0.12}
                    isAnimationActive={false}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
