import { canonicalUsage } from "../ProviderUsageAccounting.canonical.ts";
import { asObject } from "./Adapter.types.ts";

/** Codex input and output include cache and reasoning subsets respectively. */
export function codexUsage(value: unknown) {
  const usage = asObject(value);
  if (!usage) return undefined;
  return canonicalUsage({
    basis: "codex-native-counter",
    inputTokens: usage.input_tokens ?? usage.inputTokens,
    outputTokens: usage.output_tokens ?? usage.outputTokens,
    cacheReadTokens: usage.cached_input_tokens ?? usage.cachedInputTokens,
    reasoningTokens: usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
    reportedTotal: usage.total_tokens ?? usage.totalTokens,
  });
}
