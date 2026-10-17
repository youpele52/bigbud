import type { UsageSourceMetadata } from "@bigbud/contracts/server/usage.ts";

export function usageSourceLabel(
  accounting: Pick<UsageSourceMetadata, "source"> | undefined,
): string {
  if (!accounting) return "Source unavailable";
  return accounting.source === "estimated"
    ? "Estimated"
    : accounting.source === "mixed"
      ? "Mixed"
      : "";
}

/** Only draw disjoint categories when all inclusion relationships are known. */
export function disjointUsageMix(accounting: UsageSourceMetadata | undefined) {
  if (!accounting) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } =
    accounting;
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null ||
    reasoningTokens === null
  )
    return undefined;
  const fresh = inputTokens - cacheReadTokens - cacheWriteTokens;
  const visibleOutput = outputTokens - reasoningTokens;
  if (
    fresh < 0 ||
    visibleOutput < 0 ||
    inputTokens + outputTokens !== accounting.reportedTokens + accounting.estimatedTokens
  )
    return undefined;
  return {
    inputTokens: fresh,
    cachedInputTokens: cacheReadTokens,
    cacheWriteTokens,
    outputTokens: visibleOutput,
    reasoningOutputTokens: reasoningTokens,
  };
}
