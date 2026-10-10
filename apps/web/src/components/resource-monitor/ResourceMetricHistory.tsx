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
                    metric.historyStyle === "network" && name === "Upload",
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
                name="Download"
                baseValue={0}
                stroke="var(--chart-2)"
                fill="var(--chart-2)"
                fillOpacity={0.16}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="sentValue"
                name="Upload"
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
