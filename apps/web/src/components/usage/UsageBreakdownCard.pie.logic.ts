import type { ServerUsageSummaryResult } from "@bigbud/contracts";
import { usageSourceLabel } from "./UsageAccounting.logic";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/** The tooltip and legend use the same label, including provenance of collapsed entries. */
export function buildBreakdownPieData(entries: ServerUsageSummaryResult["providers"]) {
  const chartData = entries.slice(0, 4).map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    usedTokens: entry.usedTokens,
    source: entry.accounting?.source,
    fill: COLORS[index]!,
  }));
  const remaining = entries.slice(4);
  const remainingTokens = remaining.reduce((total, entry) => total + entry.usedTokens, 0);
  if (remainingTokens > 0) {
    const estimated = remaining.some(
      (entry) => entry.accounting?.source === "estimated" || entry.accounting?.source === "mixed",
    );
    const reported = remaining.some(
      (entry) =>
        entry.accounting?.source === "provider-reported" || entry.accounting?.source === "mixed",
    );
    const unknown = remaining.some((entry) => !entry.accounting);
    const source = estimated
      ? reported
        ? "mixed"
        : "estimated"
      : reported
        ? "provider-reported"
        : unknown
          ? undefined
          : "none";
    const label = source ? usageSourceLabel({ source }) : "";
    chartData.push({
      id: "other",
      label: `Other${label ? ` · ${label}` : ""}${unknown ? " · Source unavailable" : ""}`,
      usedTokens: remainingTokens,
      source,
      fill: COLORS[4],
    });
  }
  return chartData;
}
