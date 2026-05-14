/**
 * ProviderRuntimeIngestion.processor — processRuntimeEvent factory.
 *
 * Encapsulates the per-event runtime ingestion logic as a factory that accepts
 * pre-built cache helpers and service references.
 *
 * @module ProviderRuntimeIngestion.processor
 */
import {
  CommandId,
  EventId,
  MessageId,
  CheckpointRef,
  ThreadId,
  type ThinkingActivityStreamKind,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { type ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { type OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { type ServerSettingsShape } from "../../ws/serverSettings.ts";
import { type ProjectionTurnRepositoryShape } from "../../persistence/Services/ProjectionTurns.ts";
import {
  STRICT_PROVIDER_LIFECYCLE_GUARD,
  normalizeRuntimeTurnState,
  orchestrationSessionStatusFromRuntimeState,
  proposedPlanIdForTurn,
  proposedPlanIdFromEvent,
  runtimeEventToActivities,
  sameId,
  toTurnId,
} from "./ProviderRuntimeIngestion.helpers.ts";
import { resolveAssistantDeliveryMode } from "./ProviderRuntimeIngestion.assistantDelivery.ts";
import { makeProcessorHelpers } from "./ProviderRuntimeIngestion.processor.helpers.ts";
import { makeThinkingProcessorHelpers } from "./ProviderRuntimeIngestion.processor.thinking.ts";

/** Service references threaded into the processor. */
export interface RuntimeProcessorServices {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly serverSettingsService: ServerSettingsShape;
  readonly projectionTurnRepository: ProjectionTurnRepositoryShape;
}

/** Cache helpers threaded into the processor. */
export interface RuntimeProcessorCacheHelpers {
  readonly rememberAssistantMessageId: (
    threadId: ThreadId,
    turnId: string,
    messageId: MessageId,
  ) => Effect.Effect<void>;
  readonly forgetAssistantMessageId: (
    threadId: ThreadId,
    turnId: string,
    messageId: MessageId,
  ) => Effect.Effect<void>;
  readonly getAssistantMessageIdsForTurn: (
    threadId: ThreadId,
    turnId: string,
  ) => Effect.Effect<Set<MessageId>>;
  readonly clearAssistantMessageIdsForTurn: (
    threadId: ThreadId,
    turnId: string,
  ) => Effect.Effect<void>;
  readonly appendBufferedAssistantText: (
    messageId: MessageId,
    delta: string,
  ) => Effect.Effect<string>;
  readonly takeBufferedAssistantText: (messageId: MessageId) => Effect.Effect<string>;
  readonly clearBufferedAssistantText: (messageId: MessageId) => Effect.Effect<void>;
  readonly appendBufferedProposedPlan: (
    planId: string,
    delta: string,
    createdAt: string,
  ) => Effect.Effect<void>;
  readonly takeBufferedProposedPlan: (
    planId: string,
  ) => Effect.Effect<{ text: string; createdAt: string } | undefined>;
  readonly clearBufferedProposedPlan: (planId: string) => Effect.Effect<void>;
  readonly appendBufferedThinking: (input: {
    activityId: EventId;
    threadId: ThreadId;
    turnId: import("@bigbud/contracts").TurnId | undefined;
    streamKind: ThinkingActivityStreamKind;
    createdAt: string;
    delta: string;
  }) => Effect.Effect<void>;
  readonly takeBufferedThinking: (
    activityId: string,
  ) => Effect.Effect<import("../thinkingActivity.ts").BufferedThinkingActivity | undefined>;
  readonly listBufferedThinkingActivityIdsByThreadPrefix: (
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly listBufferedThinkingActivityIdsByTurnPrefix: (
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly listBufferedThinkingActivityIdsByItemToken: (
    token: string,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly clearTurnStateForSession: (threadId: ThreadId) => Effect.Effect<void>;
}

const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

/** Factory that creates a `processRuntimeEvent` Effect function from its dependencies. */
export function makeRuntimeEventProcessor(
  services: RuntimeProcessorServices,
  cacheHelpers: RuntimeProcessorCacheHelpers,
) {
  const { orchestrationEngine, serverSettingsService } = services;
  const {
    rememberAssistantMessageId,
    forgetAssistantMessageId,
    getAssistantMessageIdsForTurn,
    clearAssistantMessageIdsForTurn,
    appendBufferedAssistantText,
    appendBufferedProposedPlan,
    clearTurnStateForSession,
  } = cacheHelpers;

  const {
    isGitRepoForThread,
    finalizeAssistantMessage,
    finalizeBufferedProposedPlan,
    getSourceProposedPlanReferenceForAcceptedTurnStart,
    markSourceProposedPlanImplementedWithLogging,
  } = makeProcessorHelpers(services, cacheHelpers, providerCommandId);
  const {
    appendThinkingDelta,
    finalizeThinkingForItem,
    finalizeThinkingForTurn,
    finalizeThinkingForThread,
  } = makeThinkingProcessorHelpers(services, cacheHelpers, providerCommandId);

  return Effect.fn("processRuntimeEvent")(function* (event: ProviderRuntimeEvent) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.threadId);
    if (!thread) return;

    const now = event.createdAt;
    const eventTurnId = toTurnId(event.turnId);
    const activeTurnId = thread.session?.activeTurnId ?? null;

    const conflictsWithActiveTurn =
      activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
    const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

    const shouldApplyThreadLifecycle = (() => {
      if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
        return true;
      }
      switch (event.type) {
        case "session.exited":
          return true;
        case "session.started":
        case "thread.started":
          return true;
        case "turn.started":
          return !conflictsWithActiveTurn;
        case "turn.completed":
          if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
            return false;
          }
          if (activeTurnId !== null && eventTurnId !== undefined) {
            return sameId(activeTurnId, eventTurnId);
          }
          return true;
        default:
          return true;
      }
    })();
    const acceptedTurnStartedSourcePlan =
      event.type === "turn.started" && shouldApplyThreadLifecycle
        ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
        : null;

    if (
      event.type === "session.started" ||
      event.type === "session.state.changed" ||
      event.type === "session.exited" ||
      event.type === "thread.started" ||
      event.type === "turn.started" ||
      event.type === "turn.completed"
    ) {
      const nextActiveTurnId =
        event.type === "turn.started"
          ? (eventTurnId ?? null)
          : event.type === "turn.completed" || event.type === "session.exited"
            ? null
            : activeTurnId;
      const status = (() => {
        switch (event.type) {
          case "session.state.changed":
            return orchestrationSessionStatusFromRuntimeState(event.payload.state);
          case "turn.started":
            return "running";
          case "session.exited":
            return "stopped";
          case "turn.completed":
            return normalizeRuntimeTurnState(event.payload.state) === "failed" ? "error" : "ready";
          case "session.started":
          case "thread.started":
            return activeTurnId !== null ? "running" : "ready";
        }
      })();
      const lastError =
        event.type === "session.state.changed" && event.payload.state === "error"
          ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
          : event.type === "turn.completed" &&
              normalizeRuntimeTurnState(event.payload.state) === "failed"
            ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
            : status === "ready"
              ? null
              : (thread.session?.lastError ?? null);

      if (shouldApplyThreadLifecycle) {
        if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
          yield* markSourceProposedPlanImplementedWithLogging(
            acceptedTurnStartedSourcePlan.sourceThreadId,
            acceptedTurnStartedSourcePlan.sourcePlanId,
            thread.id,
            now,
            { eventId: event.eventId, type: event.type },
          );
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "thread-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status,
            providerName: event.provider,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: nextActiveTurnId,
            reason:
              event.type === "session.state.changed"
                ? (event.payload.reason ?? thread.session?.reason ?? null)
                : status === "ready"
                  ? null
                  : (thread.session?.reason ?? null),
            lastError,
            updatedAt: now,
          },
          createdAt: now,
        });
      }
    }

    const assistantDelta =
      event.type === "content.delta" && event.payload.streamKind === "assistant_text"
        ? event.payload.delta
        : undefined;
    const proposedPlanDelta =
      event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

    if (assistantDelta && assistantDelta.length > 0) {
      const assistantMessageId = MessageId.makeUnsafe(
        `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
      );
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
      }

      const assistantDeliveryMode = yield* Effect.map(
        serverSettingsService.getSettings,
        (settings) =>
          resolveAssistantDeliveryMode({
            provider: event.provider,
            settings,
          }),
      );
      if (assistantDeliveryMode === "buffered") {
        const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
        if (spillChunk.length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: spillChunk,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      } else {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(event, "assistant-delta"),
          threadId: thread.id,
          messageId: assistantMessageId,
          delta: assistantDelta,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
        });
      }
    }

    yield* appendThinkingDelta(event);

    if (proposedPlanDelta && proposedPlanDelta.length > 0) {
      const planId = proposedPlanIdFromEvent(event, thread.id);
      yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
    }

    const assistantCompletion =
      event.type === "item.completed" && event.payload.itemType === "assistant_message"
        ? {
            messageId: MessageId.makeUnsafe(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            ),
            fallbackText: event.payload.detail,
          }
        : undefined;
    const proposedPlanCompletion =
      event.type === "turn.proposed.completed"
        ? {
            planId: proposedPlanIdFromEvent(event, thread.id),
            turnId: toTurnId(event.turnId),
            planMarkdown: event.payload.planMarkdown,
          }
        : undefined;

    if (assistantCompletion) {
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        yield* finalizeThinkingForTurn(event, thread.id, turnId);
      } else if (event.itemId) {
        yield* finalizeThinkingForItem(event, String(event.itemId));
      }
      const assistantMessageId = assistantCompletion.messageId;
      const existingAssistantMessage = thread.messages.find(
        (entry) => entry.id === assistantMessageId,
      );
      const shouldApplyFallbackCompletionText =
        !existingAssistantMessage || existingAssistantMessage.text.length === 0;
      if (turnId) {
        yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
      }

      yield* finalizeAssistantMessage({
        event,
        threadId: thread.id,
        messageId: assistantMessageId,
        ...(turnId ? { turnId } : {}),
        createdAt: now,
        commandTag: "assistant-complete",
        finalDeltaCommandTag: "assistant-delta-finalize",
        ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
          ? { fallbackText: assistantCompletion.fallbackText }
          : {}),
      });

      if (turnId) {
        yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
      }
    }

    if (proposedPlanCompletion) {
      yield* finalizeBufferedProposedPlan({
        event,
        threadId: thread.id,
        threadProposedPlans: thread.proposedPlans,
        planId: proposedPlanCompletion.planId,
        ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
        fallbackMarkdown: proposedPlanCompletion.planMarkdown,
        updatedAt: now,
      });
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        yield* finalizeThinkingForTurn(event, thread.id, turnId);
        const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
        yield* Effect.forEach(
          assistantMessageIds,
          (assistantMessageId) =>
            finalizeAssistantMessage({
              event,
              threadId: thread.id,
              messageId: assistantMessageId,
              turnId,
              createdAt: now,
              commandTag: "assistant-complete-finalize",
              finalDeltaCommandTag: "assistant-delta-finalize-fallback",
            }),
          { concurrency: 1 },
        ).pipe(Effect.asVoid);
        yield* clearAssistantMessageIdsForTurn(thread.id, turnId);

        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanIdForTurn(thread.id, turnId),
          turnId,
          updatedAt: now,
        });
      }
    }

    if (event.type === "session.exited") {
      yield* finalizeThinkingForThread(event, thread.id);
      yield* clearTurnStateForSession(thread.id);
    }

    if (event.type === "runtime.error") {
      const runtimeErrorMessage = event.payload.message;

      const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
        ? true
        : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

      if (shouldApplyRuntimeError) {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "runtime-error-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "error",
            providerName: event.provider,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: eventTurnId ?? null,
            lastError: runtimeErrorMessage,
            updatedAt: now,
          },
          createdAt: now,
        });
      }
    }

    if (event.type === "thread.metadata.updated" && event.payload.name) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: providerCommandId(event, "thread-meta-update"),
        threadId: thread.id,
        title: event.payload.name,
      });
    }

    if (event.type === "turn.diff.updated") {
      const turnId = toTurnId(event.turnId);
      if (turnId && (yield* isGitRepoForThread(thread.id))) {
        if (thread.checkpoints.some((c) => c.turnId === turnId)) {
          // Already tracked; no-op.
        } else {
          const assistantMessageId = MessageId.makeUnsafe(
            `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
          );
          const maxTurnCount = thread.checkpoints.reduce(
            (max, c) => Math.max(max, c.checkpointTurnCount),
            0,
          );
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: providerCommandId(event, "thread-turn-diff-complete"),
            threadId: thread.id,
            turnId,
            completedAt: now,
            checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`),
            status: "missing",
            files: [],
            assistantMessageId,
            checkpointTurnCount: maxTurnCount + 1,
            createdAt: now,
          });
        }
      }
    }

    const activities = runtimeEventToActivities(event);
    yield* Effect.forEach(activities, (activity) =>
      orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(event, "thread-activity-append"),
        threadId: thread.id,
        activity,
        createdAt: activity.createdAt,
      }),
    ).pipe(Effect.asVoid);
  });
}
