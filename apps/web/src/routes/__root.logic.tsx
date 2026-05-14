import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts";
import {
  OrchestrationEvent,
  type ServerLifecycleWelcomePayload,
  type ThinkingActivityDeltaEvent,
  type ThreadId,
} from "@bigbud/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../models/editor";
import { readNativeApi } from "../rpc/nativeApi";
import {
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  startServerStateSync,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerSettings,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import {
  clearPromotedDraftThread,
  clearPromotedDraftThreads,
  useComposerDraftStore,
} from "../stores/composer";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useStore } from "../stores/main";
import { useThreadSelectionStore } from "../stores/thread";
import { useThinkingStreamStore } from "../stores/thinkingStream/thinkingStream.store";
import { useUiStateStore } from "../stores/ui";
import { useTerminalStateStore } from "../stores/terminal";
import { migrateLocalSettingsToServer } from "../hooks/useSettings";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { deriveOrchestrationBatchEffects } from "../logic/orchestration";
import { createOrchestrationRecoveryCoordinator } from "../logic/orchestration";
import { deriveReplayRetryDecision } from "../logic/orchestration";
import { retryTransportRecoveryOperation } from "../logic/orchestration";
import { getWsRpcClient } from "../rpc/wsRpcClient";
import { resolveNewChatOptions } from "../hooks/useHandleNewThread";
import {
  coalesceOrchestrationUiEvents,
  shouldFlushOrchestrationEventImmediately,
} from "./-__root.orchestration-events";

const REPLAY_RECOVERY_RETRY_DELAY_MS = 100;
const MAX_NO_PROGRESS_REPLAY_RETRIES = 3;

/** Mounts server state sync on startup. Renders nothing. */
export function ServerStateBootstrap() {
  useEffect(() => startServerStateSync(getWsRpcClient().server), []);

  return null;
}

/** Subscribes to orchestration/terminal events and applies them to the client store. Renders nothing. */
export function EventRouter() {
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const syncProjects = useUiStateStore((store) => store.syncProjects);
  const syncThreads = useUiStateStore((store) => store.syncThreads);
  const clearThreadUi = useUiStateStore((store) => store.clearThreadUi);
  const removeFromSelection = useThreadSelectionStore((store) => store.removeFromSelection);
  const applyThinkingDelta = useThinkingStreamStore((store) => store.applyThinkingDelta);
  const clearAllThinkingDeltas = useThinkingStreamStore((store) => store.clearAll);
  const reconcileThinkingActivities = useThinkingStreamStore(
    (store) => store.reconcilePersistedActivities,
  );
  const removeTerminalState = useTerminalStateStore((store) => store.removeTerminalState);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const applyTerminalEvent = useTerminalStateStore((store) => store.applyTerminalEvent);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const startedFreshChatRef = useRef(false);
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
  const disposedRef = useRef(false);
  const bootstrapFromSnapshotRef = useRef<() => Promise<void>>(async () => undefined);
  const serverConfig = useServerConfig();
  const serverSettings = useServerSettings();
  const readThinkingStreamingEnabled = useEffectEvent(() => serverSettings.enableThinkingStreaming);

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    migrateLocalSettingsToServer();
    void (async () => {
      await bootstrapFromSnapshotRef.current();
      if (disposedRef.current) {
        return;
      }

      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        if (readPathname() !== "/" || startedFreshChatRef.current) {
          return;
        }
        startedFreshChatRef.current = true;
        await handleNewThread(BUILT_IN_CHATS_PROJECT_ID, resolveNewChatOptions());
        return;
      }
      setProjectExpanded(payload.bootstrapProjectId, true);

      if (readPathname() !== "/") {
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$threadId",
        params: { threadId: payload.bootstrapThreadId },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(
    (notification: ServerConfigUpdatedNotification | null) => {
      if (!notification) return;

      const { id, payload, source } = notification;
      if (id <= seenServerConfigUpdateIdRef.current) {
        return;
      }
      seenServerConfigUpdateIdRef.current = id;
      if (source !== "keybindingsUpdated") {
        return;
      }

      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            const api = readNativeApi();
            if (!api) {
              return;
            }

            void Promise.resolve(serverConfig ?? api.server.getConfig())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    },
  );

  const handleThinkingDelta = useEffectEvent((event: ThinkingActivityDeltaEvent) => {
    if (!readThinkingStreamingEnabled()) {
      return;
    }
    applyThinkingDelta(event);
  });

  useEffect(() => {
    if (!serverSettings.enableThinkingStreaming) {
      clearAllThinkingDeltas();
    }
  }, [clearAllThinkingDeltas, serverSettings.enableThinkingStreaming]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || !serverSettings.enableThinkingStreaming) {
      return;
    }

    return api.orchestration.onThinkingDelta(handleThinkingDelta, {
      onResubscribe: () => {
        clearAllThinkingDeltas();
      },
    });
  }, [clearAllThinkingDeltas, serverSettings.enableThinkingStreaming]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    disposedRef.current = false;
    const recovery = createOrchestrationRecoveryCoordinator();
    let replayRetryTracker: import("../logic/orchestration").ReplayRetryTracker | null = null;
    let needsProviderInvalidation = false;
    const pendingDomainEvents: OrchestrationEvent[] = [];
    let flushPendingDomainEventsScheduled = false;

    const reconcileSnapshotDerivedState = () => {
      const threads = useStore.getState().threads;
      const projects = useStore.getState().projects;
      syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      syncThreads(
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
      removeOrphanedTerminalStates(activeThreadIds);
    };

    const queryInvalidationThrottler = new Throttler(
      () => {
        if (!needsProviderInvalidation) {
          return;
        }
        needsProviderInvalidation = false;
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        // Invalidate workspace entry queries so the @-mention file picker
        // reflects files created, deleted, or restored during this turn.
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    const applyEventBatch = (events: ReadonlyArray<OrchestrationEvent>) => {
      const nextEvents = recovery.markEventBatchApplied(events);
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

      applyOrchestrationEvents(uiEvents);
      reconcileThinkingActivities(uiEvents);
      if (needsProjectUiSync) {
        const projects = useStore.getState().projects;
        syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      }
      const needsThreadUiSync = nextEvents.some(
        (event) => event.type === "thread.created" || event.type === "thread.deleted",
      );
      if (needsThreadUiSync) {
        const threads = useStore.getState().threads;
        syncThreads(
          threads.map((thread) => ({
            id: thread.id,
            seedVisitedAt: thread.updatedAt ?? thread.createdAt,
          })),
        );
      }
      const draftStore = useComposerDraftStore.getState();
      for (const threadId of batchEffects.clearPromotedDraftThreadIds) {
        clearPromotedDraftThread(threadId);
      }
      for (const threadId of batchEffects.clearDeletedThreadIds) {
        draftStore.clearDraftThread(threadId);
        clearThreadUi(threadId);
      }
      for (const projectId of batchEffects.clearDeletedProjectIds) {
        draftStore.clearProjectDraftThreadId(projectId);
      }
      if (batchEffects.removeSelectedThreadIds.length > 0) {
        removeFromSelection(batchEffects.removeSelectedThreadIds);
      }
      for (const threadId of batchEffects.removeTerminalStateThreadIds) {
        removeTerminalState(threadId);
      }
    };
    const flushPendingDomainEvents = () => {
      flushPendingDomainEventsScheduled = false;
      if (disposed || pendingDomainEvents.length === 0) {
        return;
      }

      const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
      applyEventBatch(events);
    };
    const schedulePendingDomainEventFlush = () => {
      if (flushPendingDomainEventsScheduled) {
        return;
      }

      flushPendingDomainEventsScheduled = true;
      queueMicrotask(flushPendingDomainEvents);
    };

    const runReplayRecovery = async (reason: "sequence-gap" | "resubscribe"): Promise<void> => {
      if (!recovery.beginReplayRecovery(reason)) {
        return;
      }

      const fromSequenceExclusive = recovery.getState().latestSequence;
      try {
        const events = await retryTransportRecoveryOperation(
          () => api.orchestration.replayEvents(fromSequenceExclusive),
          { shouldAbort: () => disposed },
        );
        if (!disposed) {
          clearAllThinkingDeltas();
          applyEventBatch(events);
        }
      } catch {
        replayRetryTracker = null;
        recovery.failReplayRecovery();
        if (disposed) {
          return;
        }
        void fallbackToSnapshotRecovery();
        return;
      }

      if (!disposed) {
        const replayCompletion = recovery.completeReplayRecovery();
        const retryDecision = deriveReplayRetryDecision({
          previousTracker: replayRetryTracker,
          completion: replayCompletion,
          recoveryState: recovery.getState(),
          baseDelayMs: REPLAY_RECOVERY_RETRY_DELAY_MS,
          maxNoProgressRetries: MAX_NO_PROGRESS_REPLAY_RETRIES,
        });
        replayRetryTracker = retryDecision.tracker;

        if (retryDecision.shouldRetry) {
          if (retryDecision.delayMs > 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, retryDecision.delayMs);
            });
            if (disposed) {
              return;
            }
          }
          void runReplayRecovery(reason);
        } else if (replayCompletion.shouldReplay && import.meta.env.MODE !== "test") {
          console.warn(
            "[orchestration-recovery]",
            "Stopping replay recovery after no-progress retries.",
            {
              state: recovery.getState(),
            },
          );
        }
      }
    };

    const runSnapshotRecovery = async (reason: "bootstrap" | "replay-failed"): Promise<void> => {
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
        const snapshot = await retryTransportRecoveryOperation(
          () => api.orchestration.getSnapshot(),
          {
            shouldAbort: () => disposed,
          },
        );
        if (!disposed) {
          syncServerReadModel(snapshot);
          reconcileSnapshotDerivedState();
          if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
            void runReplayRecovery("sequence-gap");
          }
        }
      } catch {
        // Keep prior state and wait for welcome or a later replay attempt.
        recovery.failSnapshotRecovery();
      }
    };

    const bootstrapFromSnapshot = async (): Promise<void> => {
      await runSnapshotRecovery("bootstrap");
    };
    bootstrapFromSnapshotRef.current = bootstrapFromSnapshot;

    const fallbackToSnapshotRecovery = async (): Promise<void> => {
      await runSnapshotRecovery("replay-failed");
    };
    const unsubDomainEvent = api.orchestration.onDomainEvent(
      (event) => {
        const action = recovery.classifyDomainEvent(event.sequence);
        if (action === "apply") {
          pendingDomainEvents.push(event);
          if (shouldFlushOrchestrationEventImmediately(event)) {
            flushPendingDomainEvents();
          } else {
            schedulePendingDomainEventFlush();
          }
          return;
        }
        if (action === "recover") {
          flushPendingDomainEvents();
          void runReplayRecovery("sequence-gap");
        }
      },
      {
        onResubscribe: () => {
          flushPendingDomainEvents();
          void runReplayRecovery("resubscribe");
        },
      },
    );
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const thread = useStore.getState().threads.find((entry) => entry.id === event.threadId);
      if (thread && thread.archivedAt !== null) {
        return;
      }
      applyTerminalEvent(event);
    });
    return () => {
      disposed = true;
      disposedRef.current = true;
      needsProviderInvalidation = false;
      flushPendingDomainEventsScheduled = false;
      pendingDomainEvents.length = 0;
      queryInvalidationThrottler.cancel();
      unsubDomainEvent();
      unsubTerminalEvent();
    };
  }, [
    applyOrchestrationEvents,
    clearAllThinkingDeltas,
    queryClient,
    reconcileThinkingActivities,
    removeFromSelection,
    removeTerminalState,
    removeOrphanedTerminalStates,
    applyTerminalEvent,
    clearThreadUi,
    syncProjects,
    syncServerReadModel,
    syncThreads,
  ]);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
