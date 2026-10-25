/**
 * Claude `rate_limit_event` → bounded `account.rate-limits.updated` (SDK 0.3.301
 * `SDKRateLimitInfo`). Only allowlisted fields are kept; nothing else is forwarded.
 *
 * @module ClaudeAdapter.stream.rateLimits
 */
import { asRecord } from "./Adapter.sdk.messages.ts";

const STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);
const LIMIT_TYPES = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
]);

export interface ClaudeRateLimits {
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly resetsAt?: number;
  readonly rateLimitType?: string;
  readonly utilization?: number;
  readonly overageStatus?: string;
  readonly overageEnabled?: boolean;
  readonly isUsingOverage?: boolean;
}

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function decodeClaudeRateLimits(message: unknown): ClaudeRateLimits | undefined {
  const info = asRecord(asRecord(message)?.rate_limit_info);
  const status = info?.status;
  if (typeof status !== "string" || !STATUSES.has(status)) return undefined;
  const resetsAt = finite(info?.resetsAt);
  const utilization = finite(info?.utilization);
  const rateLimitType =
    typeof info?.rateLimitType === "string" && LIMIT_TYPES.has(info.rateLimitType)
      ? info.rateLimitType
      : undefined;
  const overageStatus =
    typeof info?.overageStatus === "string" && STATUSES.has(info.overageStatus)
      ? info.overageStatus
      : undefined;
  return {
    status: status as ClaudeRateLimits["status"],
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(rateLimitType ? { rateLimitType } : {}),
    ...(utilization !== undefined ? { utilization: Math.min(utilization, 1_000) } : {}),
    ...(overageStatus ? { overageStatus } : {}),
    ...(typeof info?.overageEnabled === "boolean" ? { overageEnabled: info.overageEnabled } : {}),
    ...(typeof info?.isUsingOverage === "boolean" ? { isUsingOverage: info.isUsingOverage } : {}),
  };
}

export function claudeRateLimitWarning(limits: ClaudeRateLimits): string | undefined {
  const window = limits.rateLimitType ? ` (${limits.rateLimitType.replaceAll("_", " ")})` : "";
  if (limits.status === "allowed_warning") return `Claude usage is close to its limit${window}.`;
  if (limits.status === "rejected") return `Claude usage limit reached${window}.`;
  return undefined;
}
