/**
 * ClaudeAdapter turn lifecycle, cursor tracking, and event emission helpers.
 *
 * Handles cursor tracking and runtime error, warning, and plan event emission.
 * Completion/result handling lives in `Adapter.stream.turn.complete.ts`.
 *
 * @module ClaudeAdapter.stream.turn
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type EventId, type ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { asCanonicalTurnId, exitPlanCaptureKey, nativeProviderRefs } from "./Adapter.utils.ts";
import { claudeSdkRuntimeRaw } from "./Adapter.sdk.projections.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { BlockHandlers } from "./Adapter.stream.blocks.ts";
import { makeTurnCompletionHandlers } from "./Adapter.stream.turn.complete.ts";

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
        payload: { providerThreadId: nextThreadId },
        providerRefs: {},
        raw: claudeSdkRuntimeRaw(message, "claude/thread/started"),
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) void cause;
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
      payload: { message, ...(detail !== undefined ? { detail } : {}) },
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
    if (!turnState || planMarkdown.length === 0) return;

    const captureKey = exitPlanCaptureKey({ toolUseId: input.toolUseId, planMarkdown });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) return;
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: { planMarkdown },
      providerRefs: nativeProviderRefs(context, { providerItemId: input.toolUseId }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: { sdkVersion: "0.3.219" },
      },
    });
  });

  const { completeTurn, handleResultMessage } = makeTurnCompletionHandlers({
    makeEventStamp,
    offerRuntimeEvent,
    nowIso,
    blocks,
    updateResumeCursor,
    emitRuntimeError,
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
