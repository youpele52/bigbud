import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { type ServerUsageSummaryResult } from "@bigbud/contracts";

import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { formatCompactNumber } from "./UsagePage.format";

type UsageBreakdownView = "bar" | "pie";

const BREAKDOWN_CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

const breakdownChartConfig = {
  usedTokens: { color: "var(--chart-2)", label: "Tokens" },
} as const;

function UsageBreakdownCard({
  entries,
  title,
  totalTokens,
  view,
}: {
  readonly entries: ServerUsageSummaryResult["providers"];
  readonly title: string;
  readonly totalTokens: number;
  readonly view: UsageBreakdownView;
}) {
  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No usage yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {view === "pie" ? (
          <UsageBreakdownPie entries={entries} totalTokens={totalTokens} />
        ) : (
          <UsageBreakdownBars entries={entries} totalTokens={totalTokens} title={title} />
        )}
      </CardContent>
    </Card>
  );
}

function UsageBreakdownBars({
  entries,
  title,
  totalTokens,
}: {
  readonly entries: ServerUsageSummaryResult["providers"];
  readonly title: string;
  readonly totalTokens: number;
}) {
  return (
    <div className="space-y-3">
      {entries.slice(0, 8).map((entry) => {
        const ratio = totalTokens > 0 ? Math.max(2, (entry.usedTokens / totalTokens) * 100) : 0;
        return (
          <div key={`${title}:${entry.id}`} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-foreground">{entry.label}</span>
              <span className="shrink-0 text-muted-foreground">
                {entry.usedTokens.toLocaleString()}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted/60">
              <div
                className="h-2 rounded-full bg-[var(--chart-2)]"
                style={{ width: `${ratio}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UsageBreakdownPie({
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

function buildBreakdownPieData(entries: ServerUsageSummaryResult["providers"]) {
  const visibleEntries = entries.slice(0, 4);
  const remainingTokens = entries.slice(4).reduce((total, entry) => total + entry.usedTokens, 0);

  const chartData = visibleEntries.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    usedTokens: entry.usedTokens,
    fill: getBreakdownColor(index),
  }));

  if (remainingTokens > 0) {
    chartData.push({
      id: "other",
      label: "Other",
      usedTokens: remainingTokens,
      fill: getBreakdownColor(4),
    });
  }

  return chartData;
}

function getBreakdownColor(index: number) {
  return BREAKDOWN_CHART_COLORS[index % BREAKDOWN_CHART_COLORS.length] ?? "var(--chart-1)";
}

export { UsageBreakdownCard, type UsageBreakdownView };
