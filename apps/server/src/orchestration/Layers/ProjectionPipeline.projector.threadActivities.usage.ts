import {
  PROVIDER_INTERACTION_MODES,
  type OrchestrationThreadActivity,
  type ProviderInteractionMode,
} from "@bigbud/contracts";
import type {
  ProjectionUsageBackfillRow,
  ProjectionUsageContribution,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import { supportsUsageAccounting } from "../usageAccountingSupport.ts";

type UsageAccountingPayload = {
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly interactionMode?: unknown;
  readonly scope?: unknown;
  readonly scopeId?: unknown;
  readonly processedTokens?: unknown;
  readonly inputTokens?: unknown;
  readonly cachedInputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly reasoningOutputTokens?: unknown;
  readonly finalized?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function providerInteractionMode(value: unknown): ProviderInteractionMode | undefined {
  return typeof value === "string" &&
    PROVIDER_INTERACTION_MODES.includes(value as ProviderInteractionMode)
    ? (value as ProviderInteractionMode)
    : undefined;
}

export function usageContributionFromActivity(input: {
  readonly threadId: ProjectionUsageContribution["threadId"];
  readonly activity: OrchestrationThreadActivity;
}): ProjectionUsageContribution | undefined {
  if (input.activity.kind !== "context-window.updated" || !isRecord(input.activity.payload)) {
    return undefined;
  }

  const accounting = input.activity.payload.accounting;
  if (!isRecord(accounting)) {
    return undefined;
  }

  const payload = accounting as UsageAccountingPayload;
  const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const interactionMode = providerInteractionMode(payload.interactionMode);
  const scope = typeof payload.scope === "string" ? payload.scope.trim() : "";
  const scopeId = typeof payload.scopeId === "string" ? payload.scopeId.trim() : "";
  const processedTokens = nonNegativeInt(payload.processedTokens);
  if (
    !provider ||
    !model ||
    !interactionMode ||
    !scope ||
    !scopeId ||
    processedTokens === undefined ||
    processedTokens <= 0
  ) {
    return undefined;
  }

  return {
    contributionId: `${provider}:${input.threadId}:${scope}:${scopeId}`,
    activityId: input.activity.id,
    threadId: input.threadId,
    turnId: input.activity.turnId,
    provider,
    model,
    interactionMode,
    occurredAt: input.activity.createdAt,
    usedTokens: processedTokens,
    inputTokens: nonNegativeInt(payload.inputTokens) ?? 0,
    cachedInputTokens: nonNegativeInt(payload.cachedInputTokens) ?? 0,
    outputTokens: nonNegativeInt(payload.outputTokens) ?? 0,
    reasoningOutputTokens: nonNegativeInt(payload.reasoningOutputTokens) ?? 0,
    finalized: payload.finalized === true,
    sourceSequence: input.activity.sequence ?? null,
    updatedAt: input.activity.createdAt,
  };
}

export function usageContributionFromBackfillRow(
  row: ProjectionUsageBackfillRow,
): ProjectionUsageContribution | undefined {
  if (
    row.kind !== "context-window.updated" ||
    !supportsUsageAccounting(row.provider) ||
    !isRecord(row.payload)
  ) {
    return undefined;
  }

  const existingAccounting = isRecord(row.payload.accounting) ? row.payload.accounting : undefined;
  const accounting = existingAccounting
    ? {
        ...existingAccounting,
        provider: row.provider,
        model: row.model,
        interactionMode: row.interactionMode,
      }
    : row.turnId
      ? {
          provider: row.provider,
          model: row.model,
          interactionMode: row.interactionMode,
          scope: "turn",
          scopeId: row.turnId,
          processedTokens: row.payload.usedTokens,
          inputTokens: row.payload.inputTokens,
          cachedInputTokens: row.payload.cachedInputTokens,
          outputTokens: row.payload.outputTokens,
          reasoningOutputTokens: row.payload.reasoningOutputTokens,
          finalized: true,
        }
      : undefined;

  if (!accounting) {
    return undefined;
  }

  return usageContributionFromActivity({
    threadId: row.threadId,
    activity: {
      id: row.activityId,
      createdAt: row.createdAt,
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { ...row.payload, accounting },
      turnId: row.turnId,
      ...(row.sequence !== undefined ? { sequence: row.sequence } : {}),
    },
  });
}
