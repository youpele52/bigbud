import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "../core/baseSchemas";

export const ServerProviderUsageLimitStatus = Schema.Literals([
  "pending",
  "available",
  "unavailable",
  "stale",
  "error",
]);
export type ServerProviderUsageLimitStatus = typeof ServerProviderUsageLimitStatus.Type;

export const ServerProviderUsageLimitWindowKind = Schema.Literals([
  "five-hour",
  "seven-day",
  "seven-day-oauth-apps",
  "seven-day-opus",
  "seven-day-sonnet",
  "model-scoped",
]);
export type ServerProviderUsageLimitWindowKind = typeof ServerProviderUsageLimitWindowKind.Type;

const UtilizationPercent = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(100),
);
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const ServerProviderUsageLimitWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ServerProviderUsageLimitWindowKind,
  label: TrimmedNonEmptyString,
  utilization: UtilizationPercent,
  resetAt: Schema.optional(IsoDateTime),
});
export type ServerProviderUsageLimitWindow = typeof ServerProviderUsageLimitWindow.Type;

export const ServerProviderExtraUsage = Schema.Struct({
  enabled: Schema.Boolean,
  monthlyLimit: Schema.optional(NonNegativeNumber),
  usedCredits: Schema.optional(NonNegativeNumber),
  utilization: Schema.optional(UtilizationPercent),
  currency: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderExtraUsage = typeof ServerProviderExtraUsage.Type;

export const ServerProviderUsageLimits = Schema.Struct({
  status: ServerProviderUsageLimitStatus,
  source: Schema.Literal("claude-agent-sdk"),
  checkedAt: IsoDateTime,
  lastSuccessfulAt: Schema.optional(IsoDateTime),
  subscriptionType: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(TrimmedNonEmptyString),
  windows: Schema.Array(ServerProviderUsageLimitWindow),
  extraUsage: Schema.optional(ServerProviderExtraUsage),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;
