import type { ServerUsageRange } from "@bigbud/contracts/server/usage.ts";

import { formatHumanReadableDate } from "~/utils/timestamp";

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatSharePercent(share: number) {
  if (share > 0 && share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(1)}%`;
}

function formatBucketAxisLabel(value: string, range: ServerUsageRange) {
  const date = new Date(value);
  if (range === "24h") {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(date);
  }
  if (range === "all") {
    return new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatBucketTooltipLabel(value: string, range: ServerUsageRange) {
  if (range === "all") {
    return formatHumanReadableDate(value, "month-year");
  }

  return formatHumanReadableDate(value, range === "24h" ? "date-time" : "date");
}

function usageBucketUnit(range: ServerUsageRange) {
  return range === "24h" ? "hour" : range === "all" ? "month" : "day";
}

export {
  formatBucketAxisLabel,
  formatBucketTooltipLabel,
  formatCompactNumber,
  formatSharePercent,
  usageBucketUnit,
};
