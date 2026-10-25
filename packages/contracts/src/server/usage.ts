import { Effect, Option, Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import { ProviderKind } from "../orchestration/orchestration.provider";

export const ServerUsageRange = Schema.Literals(["24h", "7d", "30d", "all"]);
export type ServerUsageRange = typeof ServerUsageRange.Type;

export const ServerGetUsageSummaryInput = Schema.Struct({
  range: ServerUsageRange,
});
export type ServerGetUsageSummaryInput = typeof ServerGetUsageSummaryInput.Type;

export const UsageSourceMetadata = Schema.Struct({
  source: Schema.Literals(["provider-reported", "estimated", "mixed", "none"]),
  partial: Schema.Boolean,
  legacy: Schema.Boolean,
  reportedTokens: NonNegativeInt,
  estimatedTokens: NonNegativeInt,
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  cacheReadTokens: Schema.NullOr(NonNegativeInt),
  cacheWriteTokens: Schema.NullOr(NonNegativeInt),
  reasoningTokens: Schema.NullOr(NonNegativeInt),
});
export type UsageSourceMetadata = typeof UsageSourceMetadata.Type;

/** Derived disjoint display buckets, not authoritative provider counters. */
export const UsageTokenMix = Schema.Struct({
  inputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  unclassifiedTokens: NonNegativeInt,
});
export type UsageTokenMix = typeof UsageTokenMix.Type;

export const ServerUsageTotals = Schema.Struct({
  accounting: Schema.optional(UsageSourceMetadata),
  // Additive display detail must not make authoritative usage unavailable on decode.
  tokenMix: Schema.optional(UsageTokenMix).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.none())),
  ),
  usedTokens: NonNegativeInt,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
  turnCount: NonNegativeInt,
});
export type ServerUsageTotals = typeof ServerUsageTotals.Type;

export const ServerUsageBucket = Schema.Struct({
  accounting: Schema.optional(UsageSourceMetadata),
  bucketStart: IsoDateTime,
  usedTokens: NonNegativeInt,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
  turnCount: NonNegativeInt,
});
export type ServerUsageBucket = typeof ServerUsageBucket.Type;

export const ServerUsageBreakdownEntry = Schema.Struct({
  accounting: Schema.optional(UsageSourceMetadata),
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedTokens: NonNegativeInt,
  turnCount: NonNegativeInt,
});
export type ServerUsageBreakdownEntry = typeof ServerUsageBreakdownEntry.Type;

export const ServerUsageProviderCoverage = Schema.Struct({
  provider: ProviderKind,
  status: Schema.Literals(["available", "unavailable"]),
  reason: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerUsageProviderCoverage = typeof ServerUsageProviderCoverage.Type;

export const ServerUsageSummaryResult = Schema.Struct({
  range: ServerUsageRange,
  generatedAt: IsoDateTime,
  historyStatus: Schema.Literals(["building", "ready"]),
  providerCoverage: Schema.Array(ServerUsageProviderCoverage),
  totals: ServerUsageTotals,
  buckets: Schema.Array(ServerUsageBucket),
  providers: Schema.Array(ServerUsageBreakdownEntry),
  models: Schema.Array(ServerUsageBreakdownEntry),
  favoriteProvider: Schema.NullOr(ServerUsageBreakdownEntry),
  favoriteModel: Schema.NullOr(ServerUsageBreakdownEntry),
  favoriteMode: Schema.NullOr(TrimmedNonEmptyString),
  streakDays: NonNegativeInt,
});
export type ServerUsageSummaryResult = typeof ServerUsageSummaryResult.Type;

export class ServerUsageError extends Schema.TaggedErrorClass<ServerUsageError>()(
  "ServerUsageError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
