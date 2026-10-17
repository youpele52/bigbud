import type { ServerProviderUsageLimitWindow } from "@bigbud/contracts/server/usageLimits.ts";
import {
  availableUsageLimits,
  usageNumber,
  usagePercent,
  usageRecord,
  usageResetAt,
} from "../../providerUsageLimits.ts";

/** Maps authoritative Go API percentages; local costs are not quota estimates. */
export function normalizeOpencodeGoUsageLimits(value: unknown, checkedAt: string) {
  const response = usageRecord(value);
  const usage = usageRecord(response.usage);
  const windows: ServerProviderUsageLimitWindow[] = [];
  for (const [id, kind, label] of [
    ["rolling", "five-hour", "5-hour limit"],
    ["weekly", "seven-day", "7-day limit"],
    ["monthly", "monthly", "Monthly limit"],
  ] as const) {
    if (usage[id] == null) continue;
    const window = usageRecord(usage[id]);
    const used = usageNumber(window.used);
    const limit = usageNumber(window.limit);
    const utilization =
      usagePercent(window.usagePercent ?? window.percent) ??
      (used !== undefined && limit !== undefined && limit > 0
        ? Math.min(100, (used / limit) * 100)
        : undefined);
    if (utilization === undefined) throw new Error("Missing OpenCode Go usage percentage.");
    const seconds = usageNumber(window.resetInSec);
    const resetAt =
      usageResetAt(window.resetAt ?? window.resetsAt) ??
      (seconds === undefined
        ? undefined
        : new Date(new Date(checkedAt).getTime() + seconds * 1000).toISOString());
    windows.push({ id, kind, label, utilization, ...(resetAt ? { resetAt } : {}) });
  }
  return availableUsageLimits("opencode-go-api", checkedAt, windows);
}
