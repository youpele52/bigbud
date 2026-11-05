import type { KeyboardEvent } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, XAxis, YAxis } from "recharts";

import type { ServerUsageRange } from "@bigbud/contracts/server/usage.ts";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { usageSourceLabel } from "./UsageAccounting.logic";
import {
  formatBucketAxisLabel,
  formatBucketTooltipLabel,
  formatCompactNumber,
  usageBucketUnit,
} from "./UsagePage.format";
import { stepUsageBucket, type UsageTimelineBucket } from "./UsagePage.buckets.logic";

const chartConfig = {
  usedTokens: { color: "var(--chart-2)", label: "Tokens" },
} as const;

/** Tokens per bucket; click a column (or use ←/→) to inspect it, Escape to clear. */
export function UsageOverTimeChart({
  timeline,
  range,
  selected,
  onSelect,
}: {
  readonly timeline: ReadonlyArray<UsageTimelineBucket>;
  readonly range: ServerUsageRange;
  readonly selected: string | null;
  readonly onSelect: (bucketStart: string | null) => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      onSelect(stepUsageBucket(timeline, selected, event.key === "ArrowRight" ? 1 : -1));
    } else if (event.key === "Escape" && selected) {
      event.preventDefault();
      onSelect(null);
    }
  };

  return (
    <div
      aria-label={`Tokens per ${usageBucketUnit(range)}. Use the arrow keys to inspect each ${usageBucketUnit(range)}, Escape to clear.`}
      className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
      onKeyDown={handleKeyDown}
      role="group"
      tabIndex={0}
    >
      <ChartContainer className="h-80 min-h-80" config={chartConfig}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            className="cursor-pointer"
            data={timeline as UsageTimelineBucket[]}
            onClick={(state) => {
              const bucket = timeline[Number(state.activeTooltipIndex)];
              if (bucket) onSelect(bucket.bucketStart === selected ? null : bucket.bucketStart);
            }}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.4} />
            <XAxis
              axisLine={false}
              dataKey="bucketStart"
              minTickGap={24}
              tickFormatter={(value) => formatBucketAxisLabel(value, range)}
              tickLine={false}
            />
            <YAxis
              axisLine={false}
              tickFormatter={(value) => formatCompactNumber(value)}
              tickLine={false}
              width={48}
            />
            <ChartTooltip
              cursor={{ fill: "var(--muted)", fillOpacity: 0.35 }}
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => {
                    const bucket = timeline.find((entry) => entry.bucketStart === value);
                    // Zero-filled periods have no rows, so there is no source to report.
                    const source =
                      bucket && !bucket.empty ? usageSourceLabel(bucket.accounting) : "";
                    return `${formatBucketTooltipLabel(value, range)}${source ? ` ${source}` : ""}`;
                  }}
                />
              }
            />
            <Bar
              dataKey="usedTokens"
              fill="var(--color-usedTokens)"
              name={chartConfig.usedTokens.label}
              radius={[2, 2, 0, 0]}
            >
              {timeline.map((bucket) => (
                <Cell
                  key={bucket.bucketStart}
                  fillOpacity={selected && selected !== bucket.bucketStart ? 0.38 : 1}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
