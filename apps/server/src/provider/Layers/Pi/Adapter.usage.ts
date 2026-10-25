import { randomUUID } from "node:crypto";
import { EventId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import type { ActivePiSession } from "./Adapter.types.ts";
import { eventBase, isRecord, normalizeString, normalizeUsage } from "./Adapter.utils.ts";
import { makeTokenUsageAccounting } from "../ProviderUsageAccounting.ts";
import { sumUsageCounters, usageCounter } from "../ProviderUsageAccounting.canonical.ts";

export function piUsageEvent(
  session: ActivePiSession,
  message: Record<string, unknown>,
  itemId: string,
  createdAt: string,
  raw: NonNullable<ProviderRuntimeEvent["raw"]>,
): ProviderRuntimeEvent | undefined {
  const usage = normalizeUsage(message.usage);
  if (!usage) return undefined;
  session.lastUsage = usage;
  const scopeId =
    normalizeString(message.id) ??
    (typeof message.timestamp === "number"
      ? `${session.activeTurnId}:${message.timestamp}`
      : undefined);
  if (!scopeId) return undefined;
  const nativeUsage = message.usage;
  const accounting = makeTokenUsageAccounting({
    scope: "item",
    scopeId,
    usage,
    canonical: {
      version: 2,
      source: "provider-reported",
      basis: "pi-assistant-message",
      completeness: "partial",
      inputTokens: sumUsageCounters(
        usage.inputTokens ?? null,
        usage.cachedInputTokens ?? null,
        usage.cacheWriteTokens ?? null,
      ),
      outputTokens: usage.outputTokens ?? null,
      cacheReadTokens: usage.cachedInputTokens ?? null,
      cacheWriteTokens: usage.cacheWriteTokens ?? null,
      reasoningTokens: null,
      reportedTotal: isRecord(nativeUsage) ? usageCounter(nativeUsage.totalTokens) : null,
      subtotal: usage.totalProcessedTokens ?? usage.usedTokens,
    },
  });
  return {
    ...eventBase({
      eventId: EventId.makeUnsafe(randomUUID()),
      createdAt,
      threadId: session.threadId,
      sessionEpoch: session.sessionEpoch,
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      itemId,
      raw,
    }),
    type: "thread.token-usage.updated",
    payload: { usage, ...(accounting ? { accounting } : {}) },
  };
}
