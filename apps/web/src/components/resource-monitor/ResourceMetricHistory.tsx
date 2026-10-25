import { Area, AreaChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";

import { ChartTooltip, ChartTooltipContent } from "../ui/chart";
import type { DisplayMetric, DisplayPoint } from "./ResourceMetricCard";
import { formatHistoryTooltipValue, networkDomain } from "./ResourceMetricHistory.logic";
import { formatTemperature } from "./resourceMonitor.format";

export function ResourceMetricHistory({
  metric,
  large = false,
  fill = false,
}: {
  metric: DisplayMetric;
  large?: boolean;
  /** Fill the containing grid track instead of using a fixed history height. */
  fill?: boolean;
}) {
  if ((metric.history?.length ?? 0) <= 1) return null;
  const mirrored = metric.historyStyle === "network" || metric.historyStyle === "io";
  const temperature = metric.historyStyle === "temperature";
  const incomingLabel = metric.historyStyle === "io" ? "Read" : "Download";
  const outgoingLabel = metric.historyStyle === "io" ? "Write" : "Upload";
  return (
    <div
      className={fill ? "h-full min-h-0" : large ? "h-28" : "h-12"}
      role="img"
      aria-label={`${metric.label} history`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={metric.history as DisplayPoint[]}>
          <XAxis dataKey="sequence" hide />
          {temperature ? (
            <YAxis
              domain={["dataMin - 1", "dataMax + 1"]}
              hide={!large}
              tickFormatter={formatTemperature}
              tickLine={false}
              axisLine={false}
              width={80}
              tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
            />
          ) : null}
          <ChartTooltip
            content={
              <ChartTooltipContent
                valueFormatter={(value, name) =>
                  formatHistoryTooltipValue(
                    value,
                    metric.historyValueFormatter,
                    mirrored && name === outgoingLabel,
                  )
                }
              />
            }
          />
          {mirrored ? (
            <>
              <YAxis domain={networkDomain(metric.history)} hide />
              <ReferenceLine y={0} stroke="var(--border)" />
              <Area
                type="monotone"
                dataKey="value"
                name={incomingLabel}
                baseValue={0}
                stroke="var(--chart-2)"
                fill="var(--chart-2)"
                fillOpacity={0.16}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="sentValue"
                name={outgoingLabel}
                baseValue={0}
                stroke="var(--chart-4)"
                fill="var(--chart-4)"
                fillOpacity={0.16}
                isAnimationActive={false}
              />
            </>
          ) : (
            <Area
              type={temperature ? "linear" : "monotone"}
              dataKey="value"
              name={metric.label}
              {...(temperature ? { baseValue: "dataMin" as const } : {})}
              stroke="var(--chart-1)"
              fill="var(--chart-1)"
              fillOpacity={0.12}
              isAnimationActive={false}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
