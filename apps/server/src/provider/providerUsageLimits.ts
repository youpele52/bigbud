import {
  ServerProviderUsageLimits,
  type ServerProviderUsageLimitWindow,
  type ServerProviderUsageLimits as UsageLimits,
} from "@bigbud/contracts/server/usageLimits.ts";
import { Schema } from "effect";

export type UsageLimitsSource = UsageLimits["source"];

/** Builds a quota status without exposing credentials or raw upstream errors. */
export function usageLimitsStatus(
  source: UsageLimitsSource,
  checkedAt: string,
  status: "unavailable" | "error",
): UsageLimits {
  return {
    source,
    checkedAt,
    status,
    windows: [],
    ...(status === "error" ? { message: "Subscription limits could not be refreshed." } : {}),
  };
}

/** Validates normalized provider data at the shared contract boundary. */
export function availableUsageLimits(
  source: UsageLimitsSource,
  checkedAt: string,
  windows: ReadonlyArray<ServerProviderUsageLimitWindow>,
  extra: Pick<UsageLimits, "subscriptionType" | "extraUsage"> = {},
): UsageLimits {
  return Schema.decodeUnknownSync(ServerProviderUsageLimits)({
    source,
    checkedAt,
    lastSuccessfulAt: checkedAt,
    status: windows.length > 0 ? "available" : "unavailable",
    windows,
    ...extra,
  });
}

export function usageRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid subscription usage object.");
  }
  return value as Record<string, unknown>;
}

export function usageNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid subscription usage number.");
  }
  return value;
}

/** Quota may exceed its allowance; the display bar saturates at 100%. */
export function usagePercent(value: unknown): number | undefined {
  const number = usageNumber(value);
  return number === undefined ? undefined : Math.min(100, number);
}

export function usageString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid subscription usage string.");
  }
  return value.trim();
}

export function usageResetAt(value: unknown): string | undefined {
  const text = usageString(value);
  if (text === undefined) return undefined;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid subscription reset date.");
  return date.toISOString();
}
