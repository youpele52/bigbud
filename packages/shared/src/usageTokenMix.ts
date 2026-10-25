import type { UsageAccountingV2 } from "@bigbud/contracts/orchestration/providerRuntime.usage";
import type { UsageTokenMix } from "@bigbud/contracts/server/usage.ts";

export const usageTokenMixKeys = [
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "unclassifiedTokens",
] as const;

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Missing category detail never removes a contribution from the chart. */
export function unsplitUsageTokenMix(usedTokens: number): UsageTokenMix {
  if (!isCounter(usedTokens)) throw new Error("Usage total exceeds safe integer range");
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    unclassifiedTokens: usedTokens,
  };
}

/** Separate only verified subsets; unknown cache counts remain within Input. */
export function contributionTokenMix(
  usedTokens: number,
  canonical: UsageAccountingV2 | undefined,
): UsageTokenMix {
  const fallback = unsplitUsageTokenMix(usedTokens);
  if (!canonical || canonical.source === "legacy") return fallback;
  if (canonical.source === "estimated" && canonical.basis !== "observable-text-v1") return fallback;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } =
    canonical;
  if (
    !isCounter(inputTokens) ||
    !isCounter(outputTokens) ||
    !isCounter(canonical.subtotal) ||
    canonical.subtotal !== usedTokens ||
    (canonical.reportedTotal !== null && canonical.reportedTotal !== usedTokens) ||
    ![cacheReadTokens, cacheWriteTokens, reasoningTokens, canonical.reportedTotal].every(
      (value) => value === null || isCounter(value),
    ) ||
    !Number.isSafeInteger(inputTokens + outputTokens) ||
    inputTokens + outputTokens !== usedTokens
  )
    return fallback;
  const read = cacheReadTokens ?? 0;
  const write = cacheWriteTokens ?? 0;
  if (
    !Number.isSafeInteger(read + write) ||
    read + write > inputTokens ||
    (reasoningTokens !== null && reasoningTokens > outputTokens)
  )
    return fallback;
  return {
    inputTokens: inputTokens - read - write,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    outputTokens,
    unclassifiedTokens: 0,
  };
}

/** Validate additive metadata at the client boundary, including old/mismatched servers. */
export function reconciledUsageTokenMix(
  value: unknown,
  usedTokens: number,
): UsageTokenMix | undefined {
  if (!isCounter(usedTokens) || !value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  let total = 0;
  for (const key of usageTokenMixKeys) {
    const count = candidate[key];
    if (!isCounter(count)) return undefined;
    total += count;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total === usedTokens ? (value as UsageTokenMix) : undefined;
}
