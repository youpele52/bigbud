import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { type ServerUsageSummaryResult } from "@bigbud/contracts";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { formatCompactNumber } from "./UsagePage.format";
import { buildBreakdownPieData } from "./UsageBreakdownCard.pie.logic";

const breakdownChartConfig = {
  usedTokens: { color: "var(--chart-2)", label: "Tokens" },
} as const;

export function UsageBreakdownPie({
  entries,
  totalTokens,
}: {
  readonly entries: ServerUsageSummaryResult["providers"];
  readonly totalTokens: number;
}) {
  const chartData = buildBreakdownPieData(entries);

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="relative">
        <ChartContainer className="h-64 min-h-64" config={breakdownChartConfig}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent />} />
              <Pie
                cx="50%"
                cy="50%"
                data={chartData}
                dataKey="usedTokens"
                innerRadius={68}
                nameKey="label"
                outerRadius={96}
                paddingAngle={2}
                stroke="var(--background)"
                strokeWidth={3}
              >
                {chartData.map((entry) => (
                  <Cell key={entry.id} fill={entry.fill} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="text-xs text-muted-foreground">Total</div>
            <div className="text-sm font-medium text-foreground">
              {formatCompactNumber(totalTokens)}
            </div>
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-2">
        {chartData.map((entry) => (
          <div key={entry.id} className="flex items-center justify-between gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="size-2 rounded-full" style={{ backgroundColor: entry.fill }} />
              <span className="truncate text-foreground">{entry.label}</span>
            </div>
            <span className="shrink-0 text-muted-foreground">
              {entry.usedTokens.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
