import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";

import type { ServerUsageRange } from "@bigbud/contracts/server/usage.ts";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import type { BreakdownPieEntry } from "./UsageBreakdownCard.pie.logic";
import { breakdownSeriesKey, type UsageLineRow } from "./UsagePage.buckets.logic";
import {
  formatBucketAxisLabel,
  formatBucketTooltipLabel,
  formatCompactNumber,
} from "./UsagePage.format";

/** One line per provider or model, after shadcn's multiple-line chart. */
export function UsageBreakdownLines({
  rows,
  series,
  range,
}: {
  readonly rows: ReadonlyArray<UsageLineRow>;
  readonly series: ReadonlyArray<BreakdownPieEntry>;
  readonly range: ServerUsageRange;
}) {
  const config = Object.fromEntries(
    series.map((entry, index) => [
      breakdownSeriesKey(index),
      { color: entry.fill, label: entry.label },
    ]),
  );

  return (
    <ChartContainer className="h-64 min-h-64" config={config}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart accessibilityLayer data={rows as UsageLineRow[]} margin={{ left: 0, right: 12 }}>
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
            <Line
              key={entry.id}
              dataKey={breakdownSeriesKey(index)}
              dot={false}
              name={entry.label}
              stroke={`var(--color-${breakdownSeriesKey(index)})`}
              strokeWidth={2}
              type="monotone"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}
