import { useId } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";

import type { ServerUsageRange } from "@bigbud/contracts/server/usage.ts";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import type { BreakdownPieEntry } from "./UsageBreakdownCard.pie.logic";
import { breakdownSeriesKey, type UsageTrendRow } from "./UsagePage.buckets.logic";
import {
  formatBucketAxisLabel,
  formatBucketTooltipLabel,
  formatCompactNumber,
} from "./UsagePage.format";

/**
 * One gradient-filled area per provider or model, after shadcn's interactive area chart.
 * Areas overlap rather than stack so each one shows its own tokens; series draw in
 * ranking order, so smaller ones sit on top of the larger fills.
 */
export function UsageBreakdownAreas({
  rows,
  series,
  range,
}: {
  readonly rows: ReadonlyArray<UsageTrendRow>;
  readonly series: ReadonlyArray<BreakdownPieEntry>;
  readonly range: ServerUsageRange;
}) {
  // Gradient ids must be unique per chart and safe inside `url(#…)`.
  const gradientPrefix = `usage-fill-${useId().replace(/[^\w-]/g, "")}`;
  const config = Object.fromEntries(
    series.map((entry, index) => [
      breakdownSeriesKey(index),
      { color: entry.fill, label: entry.label },
    ]),
  );

  return (
    <ChartContainer className="h-64 min-h-64" config={config}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          accessibilityLayer
          data={rows as UsageTrendRow[]}
          margin={{ left: 0, right: 12 }}
        >
          <defs>
            {series.map((entry, index) => {
              const color = `var(--color-${breakdownSeriesKey(index)})`;
              return (
                <linearGradient
                  key={entry.id}
                  id={`${gradientPrefix}-${index}`}
                  x1="0"
                  x2="0"
                  y1="0"
                  y2="1"
                >
                  <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              );
            })}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.4} />
          <XAxis
            axisLine={false}
            dataKey="bucketStart"
            minTickGap={24}
            tickFormatter={(value) => formatBucketAxisLabel(value, range)}
            tickLine={false}
            tickMargin={8}
          />
          <YAxis
            axisLine={false}
            tickFormatter={(value) => formatCompactNumber(value)}
            tickLine={false}
            width={48}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                labelFormatter={(value) => formatBucketTooltipLabel(value, range)}
              />
            }
          />
          {series.map((entry, index) => (
            <Area
              key={entry.id}
              dataKey={breakdownSeriesKey(index)}
              fill={`url(#${gradientPrefix}-${index})`}
              name={entry.label}
              stroke={`var(--color-${breakdownSeriesKey(index)})`}
              strokeWidth={1.5}
              type="monotone"
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}
