import { Schema } from "effect";
import { NonNegativeInt, PositiveInt } from "../core/baseSchemas";
import { TrimmedNonEmptyStringSchema } from "./providerRuntime.primitives";
import { ProviderInteractionMode } from "./orchestration.provider";

export const UsageAttribution = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  interactionMode: ProviderInteractionMode,
});
export type UsageAttribution = typeof UsageAttribution.Type;

/** Unknown counters remain null; zero is an observed value. */
export const UsageAccountingV2 = Schema.Struct({
  version: Schema.Literal(2),
  source: Schema.Literals(["provider-reported", "estimated", "legacy"]),
  basis: Schema.String,
  completeness: Schema.Literals(["complete", "partial"]),
  inputTokens: Schema.NullOr(NonNegativeInt),
  cacheReadTokens: Schema.NullOr(NonNegativeInt),
  cacheWriteTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  reasoningTokens: Schema.NullOr(NonNegativeInt),
  reportedTotal: Schema.NullOr(NonNegativeInt),
  subtotal: NonNegativeInt,
  model: Schema.optional(Schema.String),
  raw: Schema.optional(
    Schema.Struct({
      input: Schema.NullOr(NonNegativeInt),
      output: Schema.NullOr(NonNegativeInt),
      cacheRead: Schema.NullOr(NonNegativeInt),
      cacheWrite: Schema.NullOr(NonNegativeInt),
      reasoning: Schema.NullOr(NonNegativeInt),
    }),
  ),
});
export type UsageAccountingV2 = typeof UsageAccountingV2.Type;

export const CodexUsageObservation = Schema.Struct({
  nativeThreadId: Schema.String,
  total: UsageAccountingV2,
  last: Schema.optional(UsageAccountingV2),
});
export type CodexUsageObservation = typeof CodexUsageObservation.Type;

export const ThreadTokenUsageSnapshot = Schema.Struct({
  usedTokens: NonNegativeInt,
  totalProcessedTokens: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(PositiveInt),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  lastUsedTokens: Schema.optional(NonNegativeInt),
  lastInputTokens: Schema.optional(NonNegativeInt),
  lastCachedInputTokens: Schema.optional(NonNegativeInt),
  lastOutputTokens: Schema.optional(NonNegativeInt),
  lastReasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  compactsAutomatically: Schema.optional(Schema.Boolean),
});
export type ThreadTokenUsageSnapshot = typeof ThreadTokenUsageSnapshot.Type;

export const ThreadTokenUsageAccountingScope = Schema.Literals(["turn", "item", "task"]);
export type ThreadTokenUsageAccountingScope = typeof ThreadTokenUsageAccountingScope.Type;

export const ThreadTokenUsageAccounting = Schema.Struct({
  scope: ThreadTokenUsageAccountingScope,
  scopeId: TrimmedNonEmptyStringSchema,
  processedTokens: NonNegativeInt,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
  finalized: Schema.Boolean,
  canonical: Schema.optional(UsageAccountingV2),
  codexObservation: Schema.optional(CodexUsageObservation),
});
export type ThreadTokenUsageAccounting = typeof ThreadTokenUsageAccounting.Type;

export const ThreadTokenUsageUpdatedPayload = Schema.Struct({
  usage: Schema.optional(ThreadTokenUsageSnapshot),
  accounting: Schema.optional(ThreadTokenUsageAccounting),
});
export type ThreadTokenUsageUpdatedPayload = typeof ThreadTokenUsageUpdatedPayload.Type;
