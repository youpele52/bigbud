import { Area, AreaChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";

import { ChartTooltip, ChartTooltipContent } from "../ui/chart";
import type { DisplayMetric, DisplayPoint } from "./ResourceMetricCard";
import { formatHistoryTooltipValue, networkDomain } from "./ResourceMetricHistory.logic";

export function ResourceMetricHistory({
  metric,
  large = false,
}: {
  metric: DisplayMetric;
  large?: boolean;
}) {
  if ((metric.history?.length ?? 0) <= 1) return null;
  const mirrored = metric.historyStyle === "network" || metric.historyStyle === "io";
  const incomingLabel = metric.historyStyle === "io" ? "Read" : "Download";
  const outgoingLabel = metric.historyStyle === "io" ? "Write" : "Upload";
  return (
    <div className={large ? "h-28" : "h-12"} role="img" aria-label={`${metric.label} history`}>
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
  );
}
