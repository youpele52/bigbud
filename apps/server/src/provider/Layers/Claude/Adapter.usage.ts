import type { ThreadTokenUsageSnapshot } from "@bigbud/contracts/orchestration/providerRuntime.usage";
import {
  canonicalUsage,
  sumUsageCounters,
  usageCounter,
} from "../ProviderUsageAccounting.canonical.ts";

/** SDK main-loop input excludes both cache categories; output includes hidden reasoning. */
export function claudeCanonicalUsage(value: unknown, partial = false) {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const fresh = usageCounter(usage.input_tokens);
  const read = usageCounter(usage.cache_read_input_tokens);
  const write = usageCounter(usage.cache_creation_input_tokens);
  return canonicalUsage({
    basis: partial ? "claude-assistant-input" : "claude-result-main-loop",
    inputTokens: sumUsageCounters(fresh, read, write),
    cacheReadTokens: read,
    cacheWriteTokens: write,
    outputTokens: partial ? null : usage.output_tokens,
    reportedTotal: partial ? null : usage.total_tokens,
    partial,
  });
}

/** Context is a separate snapshot; consumption must use the unclamped canonical value. */
export function normalizeClaudeTokenUsage(
  value: unknown,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  const canonical = claudeCanonicalUsage(value);
  if (!canonical) return undefined;
  const maxTokens = usageCounter(contextWindow);
  const usedTokens =
    maxTokens !== null && maxTokens > 0
      ? Math.min(canonical.subtotal, maxTokens)
      : canonical.subtotal;
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    totalProcessedTokens: canonical.subtotal,
    ...(canonical.inputTokens !== null
      ? { inputTokens: canonical.inputTokens - (canonical.cacheReadTokens ?? 0) }
      : {}),
    ...(canonical.cacheReadTokens !== null ? { cachedInputTokens: canonical.cacheReadTokens } : {}),
    ...(canonical.cacheWriteTokens !== null
      ? { cacheWriteTokens: canonical.cacheWriteTokens }
      : {}),
    ...(canonical.outputTokens !== null ? { outputTokens: canonical.outputTokens } : {}),
    ...(maxTokens !== null && maxTokens > 0 ? { maxTokens } : {}),
  };
}
