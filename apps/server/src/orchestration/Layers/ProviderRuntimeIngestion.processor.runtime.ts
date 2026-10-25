import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";
import { resolveAssistantDeliveryMode } from "./ProviderRuntimeIngestion.assistantDelivery.ts";
import { RuntimeActivityGovernor } from "./ProviderRuntimeIngestion.activityGovernor.ts";
import { processAssistantRuntimeEvent } from "./ProviderRuntimeIngestion.processor.runtime.assistant.ts";
import {
  STRICT_PROVIDER_LIFECYCLE_GUARD,
  proposedPlanIdForTurn,
  proposedPlanIdFromEvent,
  runtimeEventToActivities,
  sameId,
  toTurnId,
} from "./ProviderRuntimeIngestion.helpers.ts";
import {
  isProviderLifecycleEvent,
  lifecycleSessionStatus,
  resolveProviderLifecycleGuard,
} from "./ProviderRuntimeIngestion.lifecycle.ts";
import { makeProcessorHelpers } from "./ProviderRuntimeIngestion.processor.helpers.ts";
import { makeThinkingProcessorHelpers } from "./ProviderRuntimeIngestion.processor.thinking.ts";
import { makeRuntimeProcessorEventHelpers } from "./ProviderRuntimeIngestion.processor.events.ts";
import { makeRuntimeTaskProcessor } from "./ProviderRuntimeIngestion.processor.tasks.ts";
import type {
  RuntimeProcessorCacheHelpers,
  RuntimeProcessorServices,
} from "./ProviderRuntimeIngestion.processor.ts";
import { ensureOrchestrationThreadState } from "../Services/OrchestrationEngine.ts";
import { buildThreadReconciliationCommand } from "./ProviderRuntimeIngestion.reconcile.ts";
import { lookupLiveSessionBestEffort } from "./ProviderRuntimeIngestion.processor.runtime.lookup.ts";
import { providerCommandId } from "./ProviderRuntimeIngestion.processor.runtime.command.ts";
import { runtimeSessionLastError } from "./ProviderRuntimeIngestion.processor.runtime.error.ts";
import { makePromptSuggestionIngestion } from "./ProviderRuntimeIngestion.promptSuggestion.ts";
import {
  isSuccessfulModelEvent,
  makeSuccessfulModelRecorder,
} from "./ProviderRuntimeIngestion.successfulModel.ts";
export function makeRuntimeEventProcessor(
  services: RuntimeProcessorServices,
  cacheHelpers: RuntimeProcessorCacheHelpers,
) {
  const { orchestrationEngine, serverSettingsService } = services;
  const activityGovernor = new RuntimeActivityGovernor();
  const recordSuccessfulModel = makeSuccessfulModelRecorder(orchestrationEngine);
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
  const { appendActivities, handleThreadMetadataUpdated, handleTurnDiffUpdated } =
    makeRuntimeProcessorEventHelpers({
      orchestrationEngine,
      serverSettingsService,
      isGitRepoForThread,
      providerCommandId,
    });
  const taskProcessor = makeRuntimeTaskProcessor({ orchestrationEngine, providerCommandId });
  const ingestPromptSuggestion = makePromptSuggestionIngestion({
    orchestrationEngine,
    serverSettingsService,
  });
  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    yield* ensureOrchestrationThreadState(orchestrationEngine, event.threadId, "history");
    yield* taskProcessor.flushDue(event, event.threadId);
    const thread = (yield* orchestrationEngine.getReadModel()).threads.find(
      (entry) => entry.id === event.threadId,
    );
    if (!thread) return;
    if (event.type === "turn.prompt-suggestion")
      return yield* ingestPromptSuggestion(event, thread);
    const now = event.createdAt;
    const sessionEpoch = event.sessionEpoch;
    const projectedSessionEpoch = thread.session?.sessionEpoch ?? 0;
    const eventTurnId = toTurnId(event.turnId);
    const activeTurnId = thread.session?.activeTurnId ?? null;
    const isLifecycleEvent = isProviderLifecycleEvent(event);
    const usesLiveSessionFence = isLifecycleEvent || event.type === "runtime.error";
    const liveSession = usesLiveSessionFence
      ? yield* lookupLiveSessionBestEffort({
          providerService: services.providerService,
          thread,
          event,
        })
      : undefined;

    const lifecycleGuard = usesLiveSessionFence
      ? resolveProviderLifecycleGuard({
          event,
          thread,
          liveSession,
          activeTurnId,
          eventTurnId,
        })
      : null;
    const shouldApplyThreadLifecycle = lifecycleGuard?.shouldApply ?? true;
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
      event.type === "turn.completed" ||
      event.type === "turn.aborted"
    ) {
      const nextActiveTurnId =
        event.type === "turn.started"
          ? (eventTurnId ?? null)
          : event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "session.exited"
            ? null
            : activeTurnId;
      const status = lifecycleSessionStatus(event, activeTurnId);
      const lastError = runtimeSessionLastError(event, status, thread.session?.lastError);

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
            retainedFamily:
              event.provider === "opencodeV2" &&
              event.type !== "session.exited" &&
              (event.type === "session.state.changed"
                ? (event.payload.retainedFamily ?? thread.session?.retainedFamily ?? false)
                : (thread.session?.retainedFamily ?? false)),
            sessionEpoch: sessionEpoch ?? 0,
            reason:
              event.type === "session.state.changed"
                ? (event.payload.reason ?? thread.session?.reason ?? null)
                : status === "ready"
                  ? null
                  : (thread.session?.reason ?? null),
            lastError,
            updatedAt: now,
          },
          expectedSessionEpoch: thread.session?.sessionEpoch ?? 0,
          ...(activeTurnId ? { expectedActiveTurnId: activeTurnId } : {}),
          createdAt: now,
        });
      } else {
        const reconciliation = buildThreadReconciliationCommand({
          thread,
          liveSession,
          occurredAt: now,
        });
        yield* Effect.logWarning("provider lifecycle event rejected and thread was reconciled", {
          eventId: event.eventId,
          eventType: event.type,
          eventProvider: event.provider,
          liveProvider: liveSession?.provider ?? null,
          projectedActiveTurnId: activeTurnId,
          eventTurnId: eventTurnId ?? null,
          liveActiveTurnId: liveSession?.activeTurnId ?? null,
          queuedPromptIds: (thread.queuedPrompts ?? []).map((prompt) => prompt.id),
          queuedPromptCount: thread.queuedPrompts?.length ?? 0,
          rejectionReason: lifecycleGuard?.rejectionReason ?? "strict-lifecycle-guard",
        });
        const liveSessionSettledAfterProjection =
          liveSession !== undefined &&
          liveSession.activeTurnId == null &&
          activeTurnId !== null &&
          liveSession.updatedAt > (thread.session?.updatedAt ?? "");
        if (
          reconciliation &&
          (activeTurnId === null ||
            liveSessionSettledAfterProjection ||
            liveSession?.activeTurnId != null)
        ) {
          yield* orchestrationEngine.dispatch(reconciliation).pipe(Effect.asVoid);
        }
        // A rejected lifecycle event belongs to an older provider session. Do not
        // let its non-lifecycle payload mutate messages, tasks, or activities.
        return;
      }
    }

    // Providers that do not emit lifecycle events still carry the session epoch.
    // Reject their late output before it reaches any projection helper.
    if (
      (sessionEpoch === undefined && projectedSessionEpoch !== 0) ||
      (sessionEpoch !== undefined && projectedSessionEpoch !== sessionEpoch)
    ) {
      return;
    }

    if (isSuccessfulModelEvent(event)) yield* recordSuccessfulModel(event, thread, liveSession);

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
        : !lifecycleGuard?.providerConflictsWithLiveSession &&
          !lifecycleGuard?.sessionEpochMismatch &&
          !lifecycleGuard?.conflictsWithLiveTurn &&
          !lifecycleGuard?.missingTurnForLiveTurn &&
          (activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId));

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
            sessionEpoch: sessionEpoch ?? 0,
            lastError: runtimeErrorMessage,
            updatedAt: now,
          },
          expectedSessionEpoch: thread.session?.sessionEpoch ?? 0,
          ...(activeTurnId ? { expectedActiveTurnId: activeTurnId } : {}),
          createdAt: now,
        });
      } else {
        const reconciliation = buildThreadReconciliationCommand({
          thread,
          liveSession,
          occurredAt: now,
        });
        yield* Effect.logWarning("provider runtime error rejected and thread was reconciled", {
          eventId: event.eventId,
          eventProvider: event.provider,
          liveProvider: liveSession?.provider ?? null,
          projectedActiveTurnId: activeTurnId,
          eventTurnId: eventTurnId ?? null,
          liveActiveTurnId: liveSession?.activeTurnId ?? null,
          queuedPromptIds: (thread.queuedPrompts ?? []).map((prompt) => prompt.id),
          queuedPromptCount: thread.queuedPrompts?.length ?? 0,
          rejectionReason: lifecycleGuard?.rejectionReason ?? "strict-lifecycle-guard",
        });
        if (reconciliation) {
          yield* orchestrationEngine.dispatch(reconciliation).pipe(Effect.asVoid);
        }
      }
    }

    if (event.type === "thread.metadata.updated") {
      yield* handleThreadMetadataUpdated({ event, threadId: thread.id });
    }

    if (event.type === "turn.diff.updated") {
      yield* handleTurnDiffUpdated({ event, thread, now });
    }

    yield* taskProcessor.processTaskEvent(event, thread.id);

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
  return Object.assign(processRuntimeEvent, {
    flushPendingSubagentUpserts: taskProcessor.flushAll,
  });
}
