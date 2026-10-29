import type { ServerUsageSummaryResult } from "@bigbud/contracts";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/**
 * Top four keep their own color; the rest fold into Other. Labels carry no provenance tags —
 * the page footer explains estimated and mixed usage once.
 */
export function buildBreakdownPieData(entries: ServerUsageSummaryResult["providers"]) {
  const chartData = entries.slice(0, 4).map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    usedTokens: entry.usedTokens,
    fill: COLORS[index]!,
  }));
  const remainingTokens = entries.slice(4).reduce((total, entry) => total + entry.usedTokens, 0);
  if (remainingTokens > 0) {
    chartData.push({ id: "other", label: "Other", usedTokens: remainingTokens, fill: COLORS[4] });
  }
  return chartData;
}

export type BreakdownPieEntry = ReturnType<typeof buildBreakdownPieData>[number];
