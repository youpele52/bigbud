import { BUILT_IN_CHATS_PROJECT_ID, type ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useState } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import { hydrateSelectedThread, runBoundedBootstrap } from "~/routes/-__root.bounded-bootstrap";
import { useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { newThreadId } from "~/lib/utils";
import { loadProjectForNewThread } from "~/hooks/useHandleNewThread";
import {
  getCompactChatModelPreference,
  isCompactChatModelPreferenceAvailable,
} from "~/models/compactChatModelPreference";
import { getNewestRecentlyUsedModel } from "~/models/recentlyUsedModels";
import { useServerProviders } from "~/rpc/serverState";

const COMPACT_THREAD_STORAGE_KEY = "bigbud:compact-chat:state:v1";

function getInitialSelection() {
  return getCompactChatModelPreference() ?? getNewestRecentlyUsedModel();
}

function readStoredThreadId(): ThreadId | null {
  try {
    const value = localStorage.getItem(COMPACT_THREAD_STORAGE_KEY);
    return value ? (value as ThreadId) : null;
  } catch {
    return null;
  }
}

function persistThreadId(threadId: ThreadId): void {
  try {
    localStorage.setItem(COMPACT_THREAD_STORAGE_KEY, threadId);
  } catch {
    // Compact chat remains usable when storage is unavailable.
  }
}

export function useCompactChatThread() {
  const [threadState, setThreadState] = useState(() => {
    const storedThreadId = readStoredThreadId();
    return {
      restoring: storedThreadId !== null,
      threadId: storedThreadId ?? newThreadId(),
    };
  });
  const { restoring, threadId } = threadState;
  const bootstrapComplete = useStore((state) => state.bootstrapComplete);
  const compactProject = useStore((state) =>
    state.projects.find((project) => project.id === BUILT_IN_CHATS_PROJECT_ID),
  );
  const serverThread = useStore((state) => state.threads.find((thread) => thread.id === threadId));
  const hydrationStatus = useStore(
    (state) => state.threadHydrationById[threadId]?.status ?? "unloaded",
  );
  const prompt = useComposerDraftStore((state) => state.draftsByThreadId[threadId]?.prompt ?? "");
  const setDraftThreadContext = useComposerDraftStore((state) => state.setDraftThreadContext);
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const clearDraftThread = useComposerDraftStore((state) => state.clearDraftThread);
  const providers = useServerProviders() ?? [];
  const [initialSelection, setInitialSelection] = useState(getInitialSelection);
  const [projectLoadAttempt, setProjectLoadAttempt] = useState(0);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [threadSyncError, setThreadSyncError] = useState<string | null>(null);
  const selectionUnavailable = Boolean(
    initialSelection && !isCompactChatModelPreferenceAvailable(initialSelection, providers),
  );

  useEffect(() => {
    persistThreadId(threadId);
  }, [threadId]);

  // The bounded startup catalog may not include the persisted compact thread.
  // Resolve it exactly before deciding that its id belongs to a local draft.
  useEffect(() => {
    if (!restoring || !bootstrapComplete) return;
    if (serverThread) {
      setThreadState((current) =>
        current.threadId === threadId ? { ...current, restoring: false } : current,
      );
      return;
    }
    const api = readNativeApi();
    if (!api) return;

    let disposed = false;
    void runBoundedBootstrap({ api, selectedThreadId: threadId, disposed: () => disposed })
      .then(() => {
        if (disposed) return;
        if (useStore.getState().threads.some((thread) => thread.id === threadId)) {
          setThreadState((current) =>
            current.threadId === threadId ? { ...current, restoring: false } : current,
          );
          return;
        }
        if (useComposerDraftStore.getState().getDraftThread(threadId)) {
          setThreadState((current) =>
            current.threadId === threadId ? { ...current, restoring: false } : current,
          );
          return;
        }
        clearDraftThread(threadId);
        setInitialSelection(getInitialSelection());
        setThreadState({ restoring: false, threadId: newThreadId() });
      })
      .catch((error: unknown) => {
        if (!disposed) console.error("Failed to restore compact chat thread", error);
      });
    return () => {
      disposed = true;
    };
  }, [bootstrapComplete, clearDraftThread, restoring, serverThread, threadId]);

  useEffect(() => {
    if (!bootstrapComplete || restoring || compactProject) return;
    const api = readNativeApi();
    if (!api) {
      setProjectLoadError("bigbud is not connected to the server.");
      return;
    }

    let disposed = false;
    setProjectLoadError(null);
    void loadProjectForNewThread({
      api,
      projectId: BUILT_IN_CHATS_PROJECT_ID,
      getProject: () =>
        useStore.getState().projects.find((project) => project.id === BUILT_IN_CHATS_PROJECT_ID),
      mergeProjectCatalogPage: useStore.getState().mergeProjectCatalogPage,
    })
      .then((project) => {
        if (!disposed && !project) {
          setProjectLoadError("The Chats project is unavailable.");
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setProjectLoadError(
            error instanceof Error ? error.message : "The Chats project could not be loaded.",
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [bootstrapComplete, compactProject, projectLoadAttempt, restoring]);

  useEffect(() => {
    if (!bootstrapComplete || restoring || !compactProject || serverThread) return;
    setDraftThreadContext(threadId, {
      projectId: BUILT_IN_CHATS_PROJECT_ID,
      branch: null,
      worktreePath: null,
      envMode: "local",
      interactionMode: "default",
      runtimeMode: "approval-required",
    });
    if (initialSelection) {
      setModelSelection(threadId, initialSelection);
    }
  }, [
    bootstrapComplete,
    compactProject,
    initialSelection,
    restoring,
    serverThread,
    setDraftThreadContext,
    setModelSelection,
    threadId,
  ]);

  useEffect(() => {
    const api = readNativeApi();
    if (
      !api ||
      !bootstrapComplete ||
      restoring ||
      !serverThread ||
      (hydrationStatus !== "unloaded" && hydrationStatus !== "failed")
    ) {
      return;
    }
    void hydrateSelectedThread({ api, threadId });
  }, [bootstrapComplete, hydrationStatus, restoring, serverThread, threadId]);

  const newChat = useCallback(async () => {
    if (prompt.trim().length > 0) {
      const discard = await window.desktopBridge?.confirm("Discard the unsent compact chat draft?");
      if (!discard) return false;
    }
    clearDraftThread(threadId);
    setInitialSelection(getInitialSelection());
    setThreadState({ restoring: false, threadId: newThreadId() });
    return true;
  }, [clearDraftThread, prompt, threadId]);

  const retryProjectLoad = useCallback(() => {
    setProjectLoadAttempt((attempt) => attempt + 1);
  }, []);

  const synchronizeMaterializedThread = useCallback(
    async (materializedThreadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) {
        setThreadSyncError("bigbud is not connected to the server.");
        return;
      }

      setThreadSyncError(null);
      try {
        await runBoundedBootstrap({
          api,
          selectedThreadId: materializedThreadId,
          disposed: () => false,
        });
        if (!useStore.getState().threads.some((thread) => thread.id === materializedThreadId)) {
          throw new Error("The new chat was not found after it was created.");
        }
        clearDraftThread(materializedThreadId);
      } catch (error) {
        setThreadSyncError(
          error instanceof Error ? error.message : "The new chat could not be synchronized.",
        );
      }
    },
    [clearDraftThread],
  );

  const retryThreadSync = useCallback(() => {
    void synchronizeMaterializedThread(threadId);
  }, [synchronizeMaterializedThread, threadId]);

  return {
    isMaterialized: Boolean(serverThread),
    newChat,
    preparing: restoring || (!compactProject && projectLoadError === null),
    projectLoadError,
    retryProjectLoad,
    retryThreadSync,
    selectionUnavailable,
    synchronizeMaterializedThread,
    threadSyncError,
    threadTitle: serverThread?.title ?? null,
    threadId,
  };
}
