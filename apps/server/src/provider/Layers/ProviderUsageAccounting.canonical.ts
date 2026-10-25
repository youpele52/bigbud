import type { UsageAccountingV2 } from "@bigbud/contracts/orchestration/providerRuntime.usage";

/** Reject imprecise, negative and fractional native counters instead of rounding them. */
export function usageCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Sum only when every operand and the resulting integer are exact. */
export function sumUsageCounters(...values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null || usageCounter(value) === null)) return null;
  return usageCounter(values.reduce<number>((sum, value) => sum + value!, 0));
}

/** Preserve uncertainty; callers must verify cache/reasoning inclusion before passing subsets. */
export function canonicalUsage(input: {
  readonly basis: string;
  readonly inputTokens?: unknown;
  readonly cacheReadTokens?: unknown;
  readonly cacheWriteTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly reasoningTokens?: unknown;
  readonly reportedTotal?: unknown;
  readonly partial?: boolean;
  readonly model?: string;
}): UsageAccountingV2 | undefined {
  const inputTokens = usageCounter(input.inputTokens);
  const outputTokens = usageCounter(input.outputTokens);
  const reportedTotal = usageCounter(input.reportedTotal);
  const subtotal = reportedTotal ?? sumUsageCounters(inputTokens ?? 0, outputTokens ?? 0);
  if (
    subtotal === null ||
    (inputTokens === null && outputTokens === null && reportedTotal === null)
  ) {
    return undefined;
  }
  const cacheReadTokens = usageCounter(input.cacheReadTokens);
  const cacheWriteTokens = usageCounter(input.cacheWriteTokens);
  const reasoningTokens = usageCounter(input.reasoningTokens);
  const invalidCache =
    inputTokens !== null &&
    ((cacheReadTokens ?? 0) > inputTokens ||
      (cacheWriteTokens ?? 0) > inputTokens ||
      (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) > inputTokens);
  const invalidReasoning = outputTokens !== null && (reasoningTokens ?? 0) > outputTokens;
  return {
    version: 2,
    source: "provider-reported",
    basis: input.basis,
    completeness:
      input.partial ||
      inputTokens === null ||
      outputTokens === null ||
      invalidCache ||
      invalidReasoning
        ? "partial"
        : "complete",
    inputTokens,
    outputTokens,
    cacheReadTokens: invalidCache ? null : cacheReadTokens,
    cacheWriteTokens: invalidCache ? null : cacheWriteTokens,
    reasoningTokens: invalidReasoning ? null : reasoningTokens,
    reportedTotal,
    subtotal,
    ...(input.model ? { model: input.model } : {}),
  };
}
