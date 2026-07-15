import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import { ProviderKind } from "../orchestration/orchestration.provider";

export const ServerUsageRange = Schema.Literals(["24h", "7d", "30d", "all"]);
export type ServerUsageRange = typeof ServerUsageRange.Type;

export const ServerGetUsageSummaryInput = Schema.Struct({
  range: ServerUsageRange,
});
export type ServerGetUsageSummaryInput = typeof ServerGetUsageSummaryInput.Type;

export const ServerUsageTotals = Schema.Struct({
  usedTokens: NonNegativeInt,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
  turnCount: NonNegativeInt,
});
export type ServerUsageTotals = typeof ServerUsageTotals.Type;

export const ServerUsageBucket = Schema.Struct({
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
