import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { type ServerUsageSummaryResult } from "@bigbud/contracts";

import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { formatCompactNumber } from "./UsagePage.format";

const tokenMixChartConfig = {
  cachedInputTokens: { color: "var(--chart-1)", label: "Cached" },
  inputTokens: { color: "var(--chart-2)", label: "Input" },
  outputTokens: { color: "var(--chart-3)", label: "Output" },
  reasoningOutputTokens: { color: "var(--chart-4)", label: "Reasoning" },
} as const;

function UsageTokenMixCard({ totals }: { readonly totals: ServerUsageSummaryResult["totals"] }) {
  const chartData = buildTokenMixData(totals);
  const chartTotal = chartData.reduce((total, entry) => total + entry.value, 0);

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Token mix</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Empty className="min-h-64">
            <EmptyHeader>
              <EmptyTitle>No mix yet.</EmptyTitle>
              <EmptyDescription>
                Token type details are not available for this range.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token mix</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <ChartContainer className="h-48 min-h-48" config={tokenMixChartConfig}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent />} />
                <Pie
                  cx="50%"
                  cy="50%"
                  data={chartData}
                  dataKey="value"
                  innerRadius={52}
                  nameKey="label"
                  outerRadius={72}
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
                {formatCompactNumber(chartTotal)}
              </div>
            </div>
          </div>
        </div>
        <div className="space-y-2">
          {chartData.map((entry) => (
            <div key={entry.id} className="flex items-center justify-between gap-3 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <span className="size-2 rounded-full" style={{ backgroundColor: entry.fill }} />
                <span className="truncate text-foreground">{entry.label}</span>
              </div>
              <span className="shrink-0 text-muted-foreground">{entry.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function buildTokenMixData(totals: ServerUsageSummaryResult["totals"]) {
  return [
    {
      id: "cachedInputTokens",
      label: tokenMixChartConfig.cachedInputTokens.label,
      value: totals.cachedInputTokens,
      fill: tokenMixChartConfig.cachedInputTokens.color,
    },
    {
      id: "inputTokens",
      label: tokenMixChartConfig.inputTokens.label,
      value: totals.inputTokens,
      fill: tokenMixChartConfig.inputTokens.color,
    },
    {
      id: "outputTokens",
      label: tokenMixChartConfig.outputTokens.label,
      value: totals.outputTokens,
      fill: tokenMixChartConfig.outputTokens.color,
    },
    {
      id: "reasoningOutputTokens",
      label: tokenMixChartConfig.reasoningOutputTokens.label,
      value: totals.reasoningOutputTokens,
      fill: tokenMixChartConfig.reasoningOutputTokens.color,
    },
  ].filter((entry) => entry.value > 0);
}

export { UsageTokenMixCard };
