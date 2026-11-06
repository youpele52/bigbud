import {
  BUILT_IN_CHATS_PROJECT_ID,
  type ThreadId,
  type ServerLifecycleWelcomePayload,
  type ThinkingActivityDeltaEvent,
} from "@bigbud/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../models/editor";
import { readNativeApi } from "../rpc/nativeApi";
import { setOrchestrationDeliveryLifecycle } from "../rpc/orchestrationDeliveryState";
import { handleDeliveryApplicationFailure } from "./-__root.delivery-failure";
import {
  recoverAndAcknowledgeDeliveryBaseline,
  routeOrchestrationDeliveryBatch,
} from "./-__root.delivery-routing";
import {
  getServerConfig,
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerSettings,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useDisconnectedExecutionTargetsSync } from "../hooks/useDisconnectedExecutionTargetsSync";
import { useStore } from "../stores/main";
import { useThreadSelectionStore } from "../stores/thread";
import { useThinkingStreamStore } from "../stores/thinkingStream/thinkingStream.store";
import { useUiStateStore } from "../stores/ui";
import { useTerminalStateStore } from "../stores/terminal";
import { migrateLocalSettingsToServer, persistServerSettings } from "../hooks/useSettings";
import { migrateHiddenComposerProvidersToServer } from "../hooks/useSettings.storage";
import { resolveNewChatOptions } from "../hooks/useHandleNewThread";
import { createEventRouterRecovery } from "./-__root.recovery";
import { resolveSelectedThreadIdFromPath } from "./-__root.bounded-bootstrap";
import { createAsyncOperationQueue } from "./-__root.recovery.serial";
import { subscribeGlobalTerminalState } from "./-__root.terminal-events";
import {
  restoreStartupContext,
  runCoalescedStartupFreshChat,
  validateStartupRestorationCandidate,
} from "./-__root.startup-restoration";

/** Subscribes to orchestration/terminal events and applies them to the client store. Renders nothing. */
export function EventRouter({ ownedThreadId }: { ownedThreadId?: ThreadId } = {}) {
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
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
  const applyTerminalEvents = useTerminalStateStore((store) => store.applyTerminalEvents);
  const reconcileTerminalInventory = useTerminalStateStore(
    (store) => store.reconcileTerminalInventory,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const readPathname = useEffectEvent(() => pathname);
  const restorationRunIdRef = useRef(0);
  const freshChatInFlightRef = useRef<{ promise: Promise<void>; runId: number } | null>(null);
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
  const disposedRef = useRef(false);
  const bootstrapBoundedRef = useRef<(threadId: ThreadId | null) => Promise<void>>(
    async () => undefined,
  );
  const serverConfig = useServerConfig();
  const serverSettings = useServerSettings();
  const readThinkingStreamingEnabled = useEffectEvent(() => serverSettings.enableThinkingStreaming);
  const readOwnedThreadId = useEffectEvent(() => ownedThreadId ?? null);
  const ownsThread = ownedThreadId !== undefined;

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    void (async () => {
      if (ownsThread) {
        await bootstrapBoundedRef.current(readOwnedThreadId());
        return;
      }

      const runId = ++restorationRunIdRef.current;
      const launchPathname = readPathname();
      const isCurrent = () =>
        !disposedRef.current &&
        restorationRunIdRef.current === runId &&
        readPathname() === launchPathname;
      migrateLocalSettingsToServer();
      const api = readNativeApi();
      if (!api) {
        return;
      }
      await restoreStartupContext({
        pathname: launchPathname,
        bootstrapProjectId: payload.bootstrapProjectId ?? null,
        bootstrapThreadId: payload.bootstrapThreadId ?? null,
        persistedThreadId: useUiStateStore.getState().lastActiveThreadId,
        bootstrap: (threadId) => bootstrapBoundedRef.current(threadId),
        validate: (candidate) => validateStartupRestorationCandidate({ api, candidate }),
        clearPersistedThread: () => useUiStateStore.getState().setLastActiveThreadId(null),
        isCurrent,
        navigateToThread: async (threadId) => {
          if (!isCurrent()) return;
          await navigate({ to: "/$threadId", params: { threadId }, replace: true });
        },
        startFreshChat: async () => {
          await runCoalescedStartupFreshChat({
            inFlight: freshChatInFlightRef,
            isCurrent,
            runId,
            start: () =>
              handleNewThread(BUILT_IN_CHATS_PROJECT_ID, resolveNewChatOptions(), {
                shouldActivate: isCurrent,
              }),
          });
        },
      });
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

  const serverConfigLoaded = serverConfig !== null;
  useEffect(() => {
    const loaded = getServerConfig();
    if (!serverConfigLoaded || !loaded || !readNativeApi()) return;
    // Awaited: the local list is dropped only after the server accepted it (retried next start).
    void migrateHiddenComposerProvidersToServer({
      serverHiddenComposerProviders: loaded.settings.hiddenComposerProviders,
      patchServer: (hiddenComposerProviders) => persistServerSettings({ hiddenComposerProviders }),
    });
  }, [serverConfigLoaded]);

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
    const eventRecovery = createEventRouterRecovery({
      api,
      ownershipScope: ownsThread ? "compact" : "main",
      queryClient,
      clearAllThinkingDeltas,
      reconcileThinkingActivities,
      applyOrchestrationEvents,
      syncProjects,
      syncThreads,
      clearThreadUi,
      removeFromSelection,
      removeTerminalState,
      removeOrphanedTerminalStates,
      applyTerminalEvent: (event) => applyTerminalEvents([event]),
    });
    const deliveryApplicationQueue = createAsyncOperationQueue();

    let selectedThreadId: ThreadId | null = readOwnedThreadId();
    const deliveryBaselineAbort = new AbortController();
    const bootstrapBounded = async (nextSelectedThreadId: ThreadId | null): Promise<void> => {
      selectedThreadId = nextSelectedThreadId;
      await eventRecovery.runBoundedRecovery("bootstrap", selectedThreadId, () => disposed);
    };
    bootstrapBoundedRef.current = bootstrapBounded;

    const fallbackToBoundedRecovery = async (): Promise<void> => {
      selectedThreadId = ownsThread
        ? readOwnedThreadId()
        : resolveSelectedThreadIdFromPath(readPathname(), selectedThreadId);
      await eventRecovery.runBoundedRecovery("replay-failed", selectedThreadId, () => disposed);
    };
    const unsubDomainEvent = api.orchestration.onDomainEvent(
      (item) =>
        deliveryApplicationQueue
          .enqueue(async () => {
            if (disposed) return;
            if (item.type === "lifecycle") {
              setOrchestrationDeliveryLifecycle(item);
              if (item.state === "fallback" && item.reasonCode === "replay_gap") {
                await fallbackToBoundedRecovery();
              }
              return;
            }
            if (item.type === "recovery") {
              selectedThreadId = ownsThread
                ? readOwnedThreadId()
                : resolveSelectedThreadIdFromPath(readPathname(), selectedThreadId);
              await recoverAndAcknowledgeDeliveryBaseline({
                recovery: item,
                recover: () =>
                  eventRecovery.runDeliveryBaselineRecovery(selectedThreadId, () => disposed),
                acknowledge: api.orchestration.acknowledgeDeliveryBaseline,
                signal: deliveryBaselineAbort.signal,
                shouldAbort: () => disposed,
              });
              return;
            }
            await routeOrchestrationDeliveryBatch({
              batch: item,
              classify: eventRecovery.classifyDomainEvent,
              recover: fallbackToBoundedRecovery,
              apply: (events) =>
                eventRecovery.applyEventBatch(events, { disposed: () => disposed }),
              getAppliedSequence: eventRecovery.getAppliedSequence,
              acknowledge: api.orchestration.acknowledgeDelivery,
            });
          })
          .catch((error: unknown) =>
            handleDeliveryApplicationFailure({
              itemType: item.type,
              error,
              fallbackToBoundedRecovery,
            }),
          ),
      {
        onResubscribe: () => undefined,
      },
    );
    const unsubTerminalEvent = subscribeGlobalTerminalState({
      terminal: api.terminal,
      isArchived: (threadId) => {
        const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
        return thread !== undefined && thread.archivedAt !== null;
      },
      applyEvents: applyTerminalEvents,
      reconcileInventory: reconcileTerminalInventory,
    });
    return () => {
      disposed = true;
      deliveryBaselineAbort.abort();
      disposedRef.current = true;
      eventRecovery.cancel();
      setOrchestrationDeliveryLifecycle(null);
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
    applyTerminalEvents,
    reconcileTerminalInventory,
    clearThreadUi,
    ownsThread,
    syncProjects,
    syncThreads,
  ]);

  useDisconnectedExecutionTargetsSync();
  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
