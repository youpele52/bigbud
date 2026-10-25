import {
  canonicalUsage,
  sumUsageCounters,
  usageCounter,
} from "../ProviderUsageAccounting.canonical.ts";

/** Preserve native cache-write/reasoning fields without guessing reasoning inclusion. */
export function normalizeOpencodeUsage(tokens: {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}) {
  const input = usageCounter(tokens.input);
  const output = usageCounter(tokens.output);
  const read = usageCounter(tokens.cache?.read);
  const write = usageCounter(tokens.cache?.write);
  const totalInput = sumUsageCounters(input, read, write);
  const subtotal = sumUsageCounters(totalInput, output);
  if (subtotal === null) return undefined;
  const usage = {
    usedTokens: subtotal,
    lastUsedTokens: subtotal,
    totalProcessedTokens: subtotal,
    inputTokens: input!,
    lastInputTokens: input!,
    outputTokens: output!,
    lastOutputTokens: output!,
    cachedInputTokens: read!,
    lastCachedInputTokens: read!,
    cacheWriteTokens: write!,
    ...(usageCounter(tokens.reasoning) !== null
      ? { reasoningOutputTokens: tokens.reasoning! }
      : {}),
  };
  const canonical = canonicalUsage({
    basis: "opencode-message-reasoning-inclusion-unverified",
    inputTokens: totalInput,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    reportedTotal: subtotal,
    partial: true,
  });
  return {
    usage,
    canonical: canonical
      ? {
          ...canonical,
          reportedTotal: null,
          raw: {
            input,
            output,
            cacheRead: read,
            cacheWrite: write,
            reasoning: usageCounter(tokens.reasoning),
          },
        }
      : undefined,
  };
}
