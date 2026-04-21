/**
 * ClaudeAdapter turn lifecycle, cursor tracking, and event emission helpers.
 *
 * Handles turn completion, cursor updates, thread-id tracking, and
 * runtime error/warning/plan event emission.
 *
 * @module ClaudeAdapter.stream.turn
 */
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type EventId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import {
  asCanonicalTurnId,
  asRuntimeItemId,
  exitPlanCaptureKey,
  maxClaudeContextWindowFromModelUsage,
  normalizeClaudeTokenUsage,
  nativeProviderRefs,
  turnStatusFromResult,
} from "./ClaudeAdapter.utils.ts";
import type { ClaudeSessionContext } from "./ClaudeAdapter.types.ts";
import { PROVIDER } from "./ClaudeAdapter.types.ts";
import type { BlockHandlers } from "./ClaudeAdapter.stream.blocks.ts";

export interface TurnHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly nowIso: Effect.Effect<string>;
  readonly sessions: Map<ThreadId, ClaudeSessionContext>;
  readonly blocks: BlockHandlers;
}

export const makeTurnHandlers = (deps: TurnHandlerDeps) => {
  const { makeEventStamp, offerRuntimeEvent, nowIso, blocks } = deps;

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    const threadId = context.session.threadId;
    if (!threadId) return;

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.turns.length,
    };

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    };
  });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (typeof message.session_id !== "string" || message.session_id.length === 0) {
      return;
    }
    const nextThreadId = message.session_id;
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) {
      void cause;
    }
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) {
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }

    // The SDK result.usage contains *accumulated* totals across all API calls
    // (input_tokens, cache_read_input_tokens, etc. summed over every request).
    // This does NOT represent the current context window size.
    // Instead, use the last known context-window-accurate usage from task_progress
    // events and treat the accumulated total as totalProcessedTokens.
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
          payload: {
            usage: usageSnapshot,
          },
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
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
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
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* blocks.completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    context.turns.push({
      id: turnState.turnId,
      items: [...turnState.items],
    });

    if (usageSnapshot) {
      const usageStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.token-usage.updated",
        eventId: usageStamp.eventId,
        provider: PROVIDER,
        createdAt: usageStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          usage: usageSnapshot,
        },
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
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(typeof result?.total_cost_usd === "number"
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
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
    if (message.type !== "result") {
      return;
    }

    const status = turnStatusFromResult(message);
    const errorMessage = message.subtype === "success" ? undefined : message.errors[0];

    if (status === "failed") {
      yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
    }

    yield* completeTurn(context, status, errorMessage, message);
  });

  return {
    updateResumeCursor,
    ensureThreadId,
    emitRuntimeError,
    emitRuntimeWarning,
    emitProposedPlanCompleted,
    completeTurn,
    handleResultMessage,
  };
};

export type TurnHandlers = ReturnType<typeof makeTurnHandlers>;
