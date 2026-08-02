import { CommandId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import { resolveAssistantDeliveryMode } from "./ProviderRuntimeIngestion.assistantDelivery.ts";
import { RuntimeActivityGovernor } from "./ProviderRuntimeIngestion.activityGovernor.ts";
import { processAssistantRuntimeEvent } from "./ProviderRuntimeIngestion.processor.runtime.assistant.ts";
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
import { isThreadTitleLocked } from "../../orchestration-tools/ThreadTitleLock.ts";
import { makeProcessorHelpers } from "./ProviderRuntimeIngestion.processor.helpers.ts";
import { makeThinkingProcessorHelpers } from "./ProviderRuntimeIngestion.processor.thinking.ts";
import {
  makeRuntimeProcessorEventHelpers,
  type TaskRuntimeEvent,
} from "./ProviderRuntimeIngestion.processor.events.ts";
import type {
  RuntimeProcessorCacheHelpers,
  RuntimeProcessorServices,
} from "./ProviderRuntimeIngestion.processor.ts";
import { ensureOrchestrationThreadState } from "../Services/OrchestrationEngine.ts";

const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

/** Factory that creates a `processRuntimeEvent` Effect function from its dependencies. */
export function makeRuntimeEventProcessor(
  services: RuntimeProcessorServices,
  cacheHelpers: RuntimeProcessorCacheHelpers,
) {
  const { orchestrationEngine, serverSettingsService } = services;
  let nextTaskOrdinal = 0;
  const activityGovernor = new RuntimeActivityGovernor();
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
  const { appendActivities, handleTurnDiffUpdated, upsertTask } = makeRuntimeProcessorEventHelpers({
    orchestrationEngine,
    serverSettingsService,
    isGitRepoForThread,
    providerCommandId,
  });

  return Effect.fn("processRuntimeEvent")(function* (event: ProviderRuntimeEvent) {
    yield* ensureOrchestrationThreadState(orchestrationEngine, event.threadId, "history");
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

    const proposedPlanDelta =
      event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

    yield* processAssistantRuntimeEvent({
      event,
      thread,
      now,
      orchestrationEngine,
      providerCommandId,
      resolveDeliveryMode: () =>
        Effect.map(serverSettingsService.getSettings, (settings) =>
          resolveAssistantDeliveryMode({ provider: event.provider, settings }),
        ),
      cacheHelpers: {
        appendBufferedAssistantText,
        forgetAssistantMessageId,
        rememberAssistantMessageId,
      },
      processorHelpers: { finalizeAssistantMessage },
      thinkingHelpers: { finalizeThinkingForItem, finalizeThinkingForTurn },
    });

    yield* appendThinkingDelta(event);

    if (proposedPlanDelta && proposedPlanDelta.length > 0) {
      const planId = proposedPlanIdFromEvent(event, thread.id);
      yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
    }

    const proposedPlanCompletion =
      event.type === "turn.proposed.completed"
        ? {
            planId: proposedPlanIdFromEvent(event, thread.id),
            turnId: toTurnId(event.turnId),
            planMarkdown: event.payload.planMarkdown,
          }
        : undefined;

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
      if (!isThreadTitleLocked(thread.id)) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }
    }

    if (event.type === "turn.diff.updated") {
      yield* handleTurnDiffUpdated({ event, thread, now });
    }

    if (event.type === "task.removed") {
      yield* orchestrationEngine.dispatch({
        type: "thread.task.remove",
        commandId: providerCommandId(event, "thread-task-remove"),
        threadId: thread.id,
        taskId: event.payload.taskId,
        source: event.payload.source,
        freshness: event.payload.freshness,
        ...(event.payload.replacement ? { replacement: event.payload.replacement } : {}),
        createdAt: event.createdAt,
      });
    } else if (
      event.type === "task.started" ||
      event.type === "task.progress" ||
      event.type === "task.completed" ||
      event.type === "task.updated"
    ) {
      yield* upsertTask({
        // The generated runtime-event union does not narrow across module boundaries.
        event: event as unknown as TaskRuntimeEvent,
        threadId: thread.id,
        ordinal: nextTaskOrdinal++,
      });
    }

    const activities = runtimeEventToActivities(event, {
      model: thread.modelSelection.model,
      interactionMode: thread.interactionMode,
    });
    yield* appendActivities({
      event,
      threadId: thread.id,
      activities: activityGovernor.take({
        threadId: thread.id,
        turnId: eventTurnId ?? null,
        activities,
      }),
    });
    if (event.type === "turn.completed" || event.type === "session.exited") {
      activityGovernor.clear({ threadId: thread.id, turnId: eventTurnId ?? null });
    }
  });
}
