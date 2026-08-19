import { type OrchestrationEvent, type ThreadId } from "@bigbud/contracts";
import { Throttler } from "@tanstack/react-pacer";
import { type QueryClient } from "@tanstack/react-query";
import {
  clearPromotedDraftThread,
  clearPromotedDraftThreads,
  useComposerDraftStore,
} from "../stores/composer";
import { useStore } from "../stores/main";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { toastManager } from "../components/ui/toast";
import {
  applySideChatLifecycleEvents,
  reconcileSideChatSnapshot,
} from "../components/chat/side-chat/sideChat.actions";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import type { readNativeApi } from "../rpc/nativeApi";
import type { SyncProjectInput, SyncThreadInput } from "../stores/ui";
import {
  createOrchestrationRecoveryCoordinator,
  deriveOrchestrationBatchEffects,
  deriveReplayRetryDecision,
  RECOVERY_OPERATION_TIMEOUT_MS,
  retryTransportRecoveryOperation,
  type ReplayRetryTracker,
} from "../logic/orchestration";
import {
  setThreadHydrationEventApplier,
  threadHydrationEventBuffer,
} from "../logic/orchestration/thread-hydration-events.logic";
import { getFailedThreadDeletionToast } from "../logic/orchestration/thread-deletion.logic";
import {
  coalesceOrchestrationUiEvents,
  shouldFlushOrchestrationEventImmediately,
} from "./-__root.orchestration-events";
import { runBoundedBootstrap } from "./-__root.bounded-bootstrap";
import {
  createSidebarCatalogRefresher,
  getHighestSequence,
  shouldRefreshSidebarCatalog,
} from "./-__root.sidebar-catalog";

export const REPLAY_RECOVERY_RETRY_DELAY_MS = 100;
export const MAX_NO_PROGRESS_REPLAY_RETRIES = 3;

interface OrchestrationRecoveryInput {
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  queryClient: QueryClient;
  clearAllThinkingDeltas: () => void;
  reconcileThinkingActivities: (events: ReadonlyArray<OrchestrationEvent>) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  syncProjects: (projects: readonly SyncProjectInput[]) => void;
  syncThreads: (threads: readonly SyncThreadInput[]) => void;
  clearThreadUi: (threadId: ThreadId) => void;
  removeFromSelection: (threadIds: readonly ThreadId[]) => void;
  removeTerminalState: (threadId: ThreadId) => void;
  removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
  applyTerminalEvent: ReturnType<
    typeof import("../stores/terminal").useTerminalStateStore.getState
  >["applyTerminalEvent"];
}

export function createEventRouterRecovery(input: OrchestrationRecoveryInput) {
  const recovery = createOrchestrationRecoveryCoordinator();
  const sidebarCatalogRefresher = createSidebarCatalogRefresher(input.api);
  let replayRetryTracker: ReplayRetryTracker | null = null;
  let needsProviderInvalidation = false;
  const pendingDomainEvents: OrchestrationEvent[] = [];
  let flushPendingDomainEventsScheduled = false;

  const reconcileSnapshotDerivedState = () => {
    const threads = useStore.getState().threads;
    reconcileSideChatSnapshot(threads);
    const projects = useStore.getState().projects;
    input.syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
    input.syncThreads(
      threads.map((thread) => ({
        id: thread.id,
        seedVisitedAt: thread.updatedAt ?? thread.createdAt,
      })),
    );
    clearPromotedDraftThreads(threads.map((thread) => thread.id));
    const draftThreadIds = Object.keys(
      useComposerDraftStore.getState().draftThreadsByThreadId,
    ) as ThreadId[];
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: threads.map((thread) => ({
        id: thread.id,
        deletedAt: null,
        archivedAt: thread.archivedAt,
      })),
      draftThreadIds,
    });
    input.removeOrphanedTerminalStates(activeThreadIds);
  };

  const queryInvalidationThrottler = new Throttler(
    () => {
      if (!needsProviderInvalidation) {
        return;
      }
      needsProviderInvalidation = false;
      void input.queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
      void input.queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
    },
    {
      wait: 100,
      leading: false,
      trailing: true,
    },
  );

  const applyAcceptedEventBatch = (
    nextEvents: ReadonlyArray<OrchestrationEvent>,
    disposed: () => boolean = () => false,
    refresh = true,
  ) => {
    if (nextEvents.length === 0) {
      return;
    }
    const batchEffects = deriveOrchestrationBatchEffects(nextEvents);
    const uiEvents = coalesceOrchestrationUiEvents(nextEvents);
    const needsProjectUiSync = nextEvents.some(
      (event) =>
        event.type === "project.created" ||
        event.type === "project.meta-updated" ||
        event.type === "project.deleted",
    );

    if (batchEffects.needsProviderInvalidation) {
      needsProviderInvalidation = true;
      void queryInvalidationThrottler.maybeExecute();
    }

    input.applyOrchestrationEvents(uiEvents);
    applySideChatLifecycleEvents(nextEvents);
    input.reconcileThinkingActivities(uiEvents);
    if (needsProjectUiSync) {
      const projects = useStore.getState().projects;
      input.syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
    }
    if (
      nextEvents.some((event) => event.type === "thread.created" || event.type === "thread.deleted")
    ) {
      const threads = useStore.getState().threads;
      input.syncThreads(
        threads.map((thread) => ({
          id: thread.id,
          seedVisitedAt: thread.updatedAt ?? thread.createdAt,
        })),
      );
    }

    if (refresh && nextEvents.some(shouldRefreshSidebarCatalog)) {
      void sidebarCatalogRefresher.refresh(disposed, getHighestSequence(nextEvents));
    }

    const draftStore = useComposerDraftStore.getState();
    for (const threadId of batchEffects.clearPromotedDraftThreadIds) {
      clearPromotedDraftThread(threadId);
    }
    for (const threadId of batchEffects.clearDeletedThreadIds) {
      draftStore.clearDraftThread(threadId);
      input.clearThreadUi(threadId);
    }
    for (const projectId of batchEffects.clearDeletedProjectIds) {
      draftStore.clearProjectDraftThreadId(projectId);
    }
    if (batchEffects.removeSelectedThreadIds.length > 0) {
      input.removeFromSelection(batchEffects.removeSelectedThreadIds);
    }
    for (const threadId of batchEffects.removeTerminalStateThreadIds) {
      input.removeTerminalState(threadId);
    }
    const failedDeleteToast = getFailedThreadDeletionToast(
      batchEffects.failedDeleteThreadIds.length,
    );
    if (failedDeleteToast) toastManager.add(failedDeleteToast);
  };

  const applyEventBatch = (
    events: ReadonlyArray<OrchestrationEvent>,
    options: { readonly disposed?: (() => boolean) | undefined; readonly refresh?: boolean } = {},
  ) => {
    const nextEvents = recovery.markEventBatchApplied(events);
    const acceptedEvents = nextEvents.filter(
      (event) => !threadHydrationEventBuffer.bufferEvent(event),
    );
    applyAcceptedEventBatch(acceptedEvents, options.disposed, options.refresh !== false);
  };
  setThreadHydrationEventApplier((events) => applyAcceptedEventBatch(events));

  const flushPendingDomainEvents = (disposed: boolean) => {
    flushPendingDomainEventsScheduled = false;
    if (disposed || pendingDomainEvents.length === 0) {
      return;
    }
    applyEventBatch(pendingDomainEvents.splice(0, pendingDomainEvents.length), {
      disposed: () => disposed,
    });
  };
  const schedulePendingDomainEventFlush = (disposed: () => boolean) => {
    if (flushPendingDomainEventsScheduled) {
      return;
    }
    flushPendingDomainEventsScheduled = true;
    queueMicrotask(() => {
      flushPendingDomainEvents(disposed());
    });
  };

  const runReplayRecovery = async (
    reason: "sequence-gap" | "resubscribe",
    disposed: () => boolean,
    fallbackToBoundedRecovery: () => void,
  ): Promise<void> => {
    if (!recovery.beginReplayRecovery(reason)) {
      return;
    }
    const fromSequenceExclusive = recovery.getState().latestSequence;
    try {
      const replay = await retryTransportRecoveryOperation(
        () => input.api.orchestration.replayEvents(fromSequenceExclusive),
        { shouldAbort: disposed, timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS },
      );
      if (replay.availability === "gap") {
        replayRetryTracker = null;
        recovery.failReplayRecovery();
        if (!disposed()) {
          fallbackToBoundedRecovery();
        }
        return;
      }
      recovery.observeReplayTarget(replay.latestSequence);
      if (!disposed()) {
        input.clearAllThinkingDeltas();
        applyEventBatch(replay.events, { disposed, refresh: false });
        if (replay.events.some(shouldRefreshSidebarCatalog)) {
          const refreshed = await sidebarCatalogRefresher.refresh(
            disposed,
            getHighestSequence(replay.events),
          );
          if (!refreshed) {
            replayRetryTracker = null;
            recovery.failReplayRecovery();
            if (!disposed()) {
              fallbackToBoundedRecovery();
            }
            return;
          }
        }
      }
    } catch {
      replayRetryTracker = null;
      recovery.failReplayRecovery();
      if (!disposed()) {
        fallbackToBoundedRecovery();
      }
      return;
    }

    if (disposed()) {
      return;
    }
    const replayCompletion = recovery.completeReplayRecovery();
    const retryDecision = deriveReplayRetryDecision({
      previousTracker: replayRetryTracker,
      completion: replayCompletion,
      recoveryState: recovery.getState(),
      baseDelayMs: REPLAY_RECOVERY_RETRY_DELAY_MS,
      maxNoProgressRetries: MAX_NO_PROGRESS_REPLAY_RETRIES,
    });
    replayRetryTracker = retryDecision.tracker;

    if (!retryDecision.shouldRetry) {
      if (replayCompletion.shouldReplay && import.meta.env.MODE !== "test") {
        console.warn(
          "[orchestration-recovery]",
          "Stopping replay recovery after no-progress retries.",
          {
            state: recovery.getState(),
          },
        );
      }
      return;
    }

    if (retryDecision.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDecision.delayMs);
      });
      if (disposed()) {
        return;
      }
    }
    void runReplayRecovery(reason, disposed, fallbackToBoundedRecovery);
  };

  const runBoundedRecovery = async (
    reason: "bootstrap" | "replay-failed",
    selectedThreadId: ThreadId | null,
    disposed: () => boolean,
  ): Promise<void> => {
    const started = recovery.beginSnapshotRecovery(reason);
    if (import.meta.env.MODE !== "test") {
      const state = recovery.getState();
      console.info("[orchestration-recovery]", "Snapshot recovery requested.", {
        reason,
        skipped: !started,
        ...(started
          ? {}
          : {
              blockedBy: state.inFlight?.kind ?? null,
              blockedByReason: state.inFlight?.reason ?? null,
            }),
        state,
      });
    }
    if (!started) {
      return;
    }
    try {
      const projectionSequence = await retryTransportRecoveryOperation(
        () => runBoundedBootstrap({ api: input.api, selectedThreadId, disposed }),
        { shouldAbort: disposed, timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS },
      );
      if (!disposed()) {
        reconcileSnapshotDerivedState();
        if (recovery.completeSnapshotRecovery(projectionSequence)) {
          void runReplayRecovery("sequence-gap", disposed, () => {
            void runBoundedRecovery("replay-failed", selectedThreadId, disposed);
          });
        }
      }
    } catch (error) {
      recovery.failSnapshotRecovery();
      if (import.meta.env.MODE !== "test") {
        console.warn("[orchestration-recovery]", "Snapshot recovery failed.", {
          reason,
          error,
          state: recovery.getState(),
        });
      }
    }
  };

  return {
    applyEventBatch,
    flushPendingDomainEvents,
    schedulePendingDomainEventFlush,
    runReplayRecovery,
    runBoundedRecovery,
    classifyDomainEvent: recovery.classifyDomainEvent.bind(recovery),
    cancel: () => {
      needsProviderInvalidation = false;
      flushPendingDomainEventsScheduled = false;
      pendingDomainEvents.length = 0;
      sidebarCatalogRefresher.cancel();
      queryInvalidationThrottler.cancel();
      threadHydrationEventBuffer.clear();
      setThreadHydrationEventApplier(null);
    },
    pushPendingDomainEvent: (event: OrchestrationEvent) => {
      pendingDomainEvents.push(event);
    },
    shouldFlushImmediately: shouldFlushOrchestrationEventImmediately,
  };
}
