import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type EventId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { asRuntimeItemId, nativeProviderRefs, normalizeClaudeTokenUsage } from "./Adapter.utils.ts";
import { turnStatusFromResult } from "./Adapter.utils.sdk.ts";
import { decodeClaudeResultMessage, type ClaudeSdkResult } from "./Adapter.sdk.messages.ts";
import { claudeSdkDiagnostic } from "./Adapter.sdk.projections.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { BlockHandlers } from "./Adapter.stream.blocks.ts";
import { makeTokenUsageAccounting } from "../ProviderUsageAccounting.ts";

export interface TurnCompletionDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly nowIso: Effect.Effect<string>;
  readonly blocks: BlockHandlers;
  readonly updateResumeCursor: (context: ClaudeSessionContext) => Effect.Effect<void>;
  readonly emitRuntimeError: (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) => Effect.Effect<void>;
}

export const makeTurnCompletionHandlers = (deps: TurnCompletionDeps) => {
  const {
    makeEventStamp,
    offerRuntimeEvent,
    nowIso,
    blocks,
    updateResumeCursor,
    emitRuntimeError,
  } = deps;

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: ClaudeSdkResult,
  ) {
    const resultContextWindow = result?.modelUsage
      ? Math.max(...Object.values(result.modelUsage).map((usage) => usage.contextWindow))
      : undefined;
    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }
    const accumulatedSnapshot = normalizeClaudeTokenUsage(
      result?.usage,
      resultContextWindow ?? context.lastKnownContextWindow,
    );
    const accumulatedTotalProcessedTokens =
      accumulatedSnapshot?.totalProcessedTokens ?? accumulatedSnapshot?.usedTokens;
    const lastGoodUsage = context.lastKnownTokenUsage;
    const maxTokens = resultContextWindow ?? context.lastKnownContextWindow;
    const usageSnapshot =
      lastGoodUsage !== undefined
        ? {
            ...lastGoodUsage,
            ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
              ? { maxTokens }
              : {}),
            ...(typeof accumulatedTotalProcessedTokens === "number" &&
            Number.isFinite(accumulatedTotalProcessedTokens) &&
            accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
              ? { totalProcessedTokens: accumulatedTotalProcessedTokens }
              : {}),
          }
        : accumulatedSnapshot;

    const turnState = context.turnState;
    if (!turnState) {
      if (usageSnapshot) {
        const usageStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          eventId: usageStamp.eventId,
          provider: PROVIDER,
          createdAt: usageStamp.createdAt,
          threadId: context.session.threadId,
          payload: { usage: usageSnapshot },
          providerRefs: {},
        });
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          state: status,
          ...(result?.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
          ...(result ? { usageAvailable: accumulatedSnapshot !== undefined } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        providerRefs: {},
      });
      return;
    }

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: { toolName: tool.toolName, input: tool.input },
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ? claudeSdkDiagnostic(result) : { status },
        },
      });
      context.inFlightTools.delete(index);
    }
    context.inFlightTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* blocks.completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        ...(result ? { rawPayload: claudeSdkDiagnostic(result) } : {}),
      });
    }

    context.turns.push({ id: turnState.turnId, items: [...turnState.items] });

    if (usageSnapshot) {
      const usageStamp = yield* makeEventStamp();
      const accounting = accumulatedSnapshot
        ? makeTokenUsageAccounting({
            scope: "turn",
            scopeId: turnState.turnId,
            usage: accumulatedSnapshot,
            finalized: true,
          })
        : undefined;
      yield* offerRuntimeEvent({
        type: "thread.token-usage.updated",
        eventId: usageStamp.eventId,
        provider: PROVIDER,
        createdAt: usageStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: { usage: usageSnapshot, ...(accounting ? { accounting } : {}) },
        providerRefs: nativeProviderRefs(context),
      });
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(result?.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        ...(result ? { usageAvailable: accumulatedSnapshot !== undefined } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });

    const updatedAt = yield* nowIso;
    context.turnState = undefined;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
      ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
    };
    yield* updateResumeCursor(context);
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") return;

    const result = decodeClaudeResultMessage(message);
    if (!result) {
      yield* emitRuntimeError(
        context,
        "Invalid Claude SDK result message.",
        claudeSdkDiagnostic(message),
      );
      return;
    }
    const status = turnStatusFromResult(message);
    const errorMessage = status === "completed" ? undefined : result.errors[0];
    if (result.fastModeDisabledReason || result.apiErrorStatus !== undefined) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "runtime.warning",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        payload: {
          message: result.fastModeDisabledReason
            ? "Claude fast mode is unavailable for this result."
            : "Claude result includes an API error status.",
          detail: {
            ...(result.fastModeDisabledReason ? { fastModeDisabled: true } : {}),
            ...(result.apiErrorStatus !== undefined
              ? { apiErrorStatus: result.apiErrorStatus }
              : {}),
          },
        },
        providerRefs: nativeProviderRefs(context),
      });
    }
    if (status === "failed") {
      yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
    }
    yield* completeTurn(context, status, errorMessage, result);
  });

  return { completeTurn, handleResultMessage };
};
