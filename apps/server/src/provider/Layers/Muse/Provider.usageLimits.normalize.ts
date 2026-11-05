import type {
  ServerProviderUsageLimits,
  ServerProviderUsageLimitWindow,
} from "@bigbud/contracts/server/usageLimits.ts";

import { availableUsageLimits, usagePercent, usageRecord } from "../../providerUsageLimits.ts";

export const MUSE_USAGE_SOURCE = "muse-msp" as const;

/** Accepts the MSP camelCase shape and the snake_case spelling Muse uses internally. */
function field(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

/** Epoch ms (MSP `resetsAtMs`), epoch seconds, or an ISO string → ISO, else undefined. */
function resetAt(record: Record<string, unknown>): string | undefined {
  const raw = field(record, "resetsAtMs", "resets_at_ms") ?? field(record, "resetsAt", "resets_at");
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return ms <= 8.64e15 ? new Date(ms).toISOString() : undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return undefined;
}

function windowLabel(
  minutes: number | undefined,
): Pick<ServerProviderUsageLimitWindow, "kind" | "label"> {
  if (minutes === 300) return { kind: "five-hour", label: "5-hour limit" };
  if (minutes !== undefined && minutes > 0 && minutes % 60 === 0) {
    return { kind: "rolling", label: `${minutes / 60}-hour limit` };
  }
  return { kind: "rolling", label: "Current window" };
}

function period(
  value: unknown,
  id: string,
  base: Pick<ServerProviderUsageLimitWindow, "kind" | "label"> | undefined,
): ServerProviderUsageLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const record = usageRecord(value);
  // Meta percentages are verbatim and may exceed 100; the shared helper caps the bar.
  const utilization = usagePercent(field(record, "usedPercent", "used_percent"));
  if (utilization === undefined) return undefined;
  const minutes = field(record, "windowDurationMins", "window_duration_mins");
  const labels = base ?? windowLabel(typeof minutes === "number" ? minutes : undefined);
  const reset = resetAt(record);
  return { id, ...labels, utilization, ...(reset ? { resetAt: reset } : {}) };
}

/** `everyday_usage` → `Everyday Usage`; the tier id is otherwise shown verbatim. */
export function formatMuseTier(tier: unknown): string | undefined {
  if (typeof tier !== "string" || !tier.trim()) return undefined;
  return tier
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Normalize a Muse allowance: the MSP `SubscriptionUsage` (`usage/read`,
 * `usage/changed`) or the `allowance` object of `muse usage --json`. Both carry
 * a tier, the provider's current window and an optional rolling weekly block.
 */
export function normalizeMuseUsage(value: unknown, checkedAt: string): ServerProviderUsageLimits {
  const usage = usageRecord(value);
  const windows = [
    period(usage.window, "window", undefined),
    period(usage.weekly, "weekly", { kind: "seven-day", label: "7-day limit" }),
  ].filter((window): window is ServerProviderUsageLimitWindow => window !== undefined);
  const tier = formatMuseTier(usage.tier);
  return availableUsageLimits(
    MUSE_USAGE_SOURCE,
    checkedAt,
    windows,
    tier ? { subscriptionType: tier } : {},
  );
}
