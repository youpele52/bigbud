import type {
  ThreadTokenUsageAccounting,
  ThreadTokenUsageAccountingScope,
  ThreadTokenUsageSnapshot,
} from "@bigbud/contracts";

export function makeTokenUsageAccounting(input: {
  readonly scope: ThreadTokenUsageAccountingScope;
  readonly scopeId: string | undefined;
  readonly usage: ThreadTokenUsageSnapshot;
  readonly processedTokens?: number;
  readonly finalized?: boolean;
}): ThreadTokenUsageAccounting | undefined {
  const scopeId = input.scopeId?.trim();
  if (!scopeId) {
    return undefined;
  }

  const processedTokens =
    input.processedTokens ??
    input.usage.totalProcessedTokens ??
    input.usage.lastUsedTokens ??
    input.usage.usedTokens;
  if (processedTokens <= 0) {
    return undefined;
  }

  return {
    scope: input.scope,
    scopeId,
    processedTokens,
    inputTokens: input.usage.inputTokens ?? input.usage.lastInputTokens ?? 0,
    cachedInputTokens: input.usage.cachedInputTokens ?? input.usage.lastCachedInputTokens ?? 0,
    outputTokens: input.usage.outputTokens ?? input.usage.lastOutputTokens ?? 0,
    reasoningOutputTokens:
      input.usage.reasoningOutputTokens ?? input.usage.lastReasoningOutputTokens ?? 0,
    finalized: input.finalized ?? true,
  };
}
