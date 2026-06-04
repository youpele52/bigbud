import {
  BUILT_IN_CHATS_PROJECT_ID,
  type ServerLifecycleWelcomePayload,
  type ThinkingActivityDeltaEvent,
} from "@bigbud/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../models/editor";
import { readNativeApi } from "../rpc/nativeApi";
import {
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerSettings,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useStore } from "../stores/main";
import { useThreadSelectionStore } from "../stores/thread";
import { useThinkingStreamStore } from "../stores/thinkingStream/thinkingStream.store";
import { useUiStateStore } from "../stores/ui";
import { useTerminalStateStore } from "../stores/terminal";
import { migrateLocalSettingsToServer } from "../hooks/useSettings";
import { resolveNewChatOptions } from "../hooks/useHandleNewThread";
import { createEventRouterRecovery } from "./-__root.recovery";

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
  const applyTerminalEvents = useTerminalStateStore((store) => store.applyTerminalEvents);
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
    const eventRecovery = createEventRouterRecovery({
      api,
      queryClient,
      clearAllThinkingDeltas,
      reconcileThinkingActivities,
      applyOrchestrationEvents,
      syncServerReadModel,
      syncProjects,
      syncThreads,
      clearThreadUi,
      removeFromSelection,
      removeTerminalState,
      removeOrphanedTerminalStates,
      applyTerminalEvent: (event) => applyTerminalEvents([event]),
    });

    const pendingTerminalEvents: Array<import("@bigbud/contracts").TerminalEvent> = [];
    let flushPendingTerminalEventsScheduled = false;
    const flushPendingTerminalEvents = () => {
      flushPendingTerminalEventsScheduled = false;
      if (disposed || pendingTerminalEvents.length === 0) {
        return;
      }
      applyTerminalEvents(pendingTerminalEvents.splice(0, pendingTerminalEvents.length));
    };
    const schedulePendingTerminalEventsFlush = () => {
      if (flushPendingTerminalEventsScheduled) {
        return;
      }
      flushPendingTerminalEventsScheduled = true;
      queueMicrotask(() => {
        flushPendingTerminalEvents();
      });
    };

    const bootstrapFromSnapshot = async (): Promise<void> => {
      await eventRecovery.runSnapshotRecovery("bootstrap", () => disposed);
    };
    bootstrapFromSnapshotRef.current = bootstrapFromSnapshot;

    const fallbackToSnapshotRecovery = async (): Promise<void> => {
      await eventRecovery.runSnapshotRecovery("replay-failed", () => disposed);
    };
    const unsubDomainEvent = api.orchestration.onDomainEvent(
      (event) => {
        const action = eventRecovery.classifyDomainEvent(event.sequence);
        if (action === "apply") {
          eventRecovery.pushPendingDomainEvent(event);
          if (eventRecovery.shouldFlushImmediately(event)) {
            eventRecovery.flushPendingDomainEvents(disposed);
          } else {
            eventRecovery.schedulePendingDomainEventFlush(() => disposed);
          }
          return;
        }
        if (action === "recover") {
          eventRecovery.flushPendingDomainEvents(disposed);
          void eventRecovery.runReplayRecovery(
            "sequence-gap",
            () => disposed,
            () => {
              void fallbackToSnapshotRecovery();
            },
          );
        }
      },
      {
        onResubscribe: () => {
          eventRecovery.flushPendingDomainEvents(disposed);
          void eventRecovery.runReplayRecovery(
            "resubscribe",
            () => disposed,
            () => {
              void fallbackToSnapshotRecovery();
            },
          );
        },
      },
    );
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const thread = useStore.getState().threads.find((entry) => entry.id === event.threadId);
      if (thread && thread.archivedAt !== null) {
        return;
      }
      pendingTerminalEvents.push(event);
      schedulePendingTerminalEventsFlush();
    });
    return () => {
      disposed = true;
      disposedRef.current = true;
      eventRecovery.cancel();
      flushPendingTerminalEventsScheduled = false;
      pendingTerminalEvents.length = 0;
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
    clearThreadUi,
    syncProjects,
    syncServerReadModel,
    syncThreads,
  ]);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
