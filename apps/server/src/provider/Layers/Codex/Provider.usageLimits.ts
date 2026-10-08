import type { ServerProviderUsageLimitWindow } from "@bigbud/contracts/server/usageLimits.ts";
import {
  availableUsageLimits,
  usageNumber,
  usagePercent,
  usageRecord,
  usageString,
} from "../../providerUsageLimits.ts";

/** Maps account/rateLimits/read: https://developers.openai.com/codex/app-server/#6-rate-limits-chatgpt */
export function normalizeCodexUsageLimits(value: unknown, checkedAt: string) {
  const response = usageRecord(value);
  const buckets = response.rateLimitsByLimitId
    ? Object.entries(usageRecord(response.rateLimitsByLimitId))
    : response.rateLimits
      ? [["codex", response.rateLimits] as const]
      : [];
  const windows: ServerProviderUsageLimitWindow[] = [];
  let subscriptionType: string | undefined;
  for (const [id, raw] of buckets) {
    const bucket = usageRecord(raw);
    subscriptionType ??= usageString(bucket.planType);
    const name = usageString(bucket.limitName) ?? id;
    for (const key of ["primary", "secondary"] as const) {
      if (bucket[key] == null) continue;
      const window = usageRecord(bucket[key]);
      const utilization = usagePercent(window.usedPercent);
      if (utilization === undefined) throw new Error("Missing Codex usage percentage.");
      const duration = usageNumber(window.windowDurationMins);
      const resetSeconds = usageNumber(window.resetsAt);
      const resetAt =
        resetSeconds === undefined ? undefined : new Date(resetSeconds * 1000).toISOString();
      windows.push({
        id: `${id}:${key}`,
        kind: duration === 300 ? "five-hour" : duration === 10080 ? "seven-day" : "rolling",
        label: `${id === "codex" ? "" : `${name} `}${windowLabel(duration, key)}`,
        utilization,
        ...(resetAt ? { resetAt } : {}),
      });
    }
  }
  return availableUsageLimits(
    "codex-app-server",
    checkedAt,
    windows,
    subscriptionType ? { subscriptionType } : {},
  );
}

function windowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined || minutes === 0)
    return `${fallback === "primary" ? "Primary" : "Secondary"} limit`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}
