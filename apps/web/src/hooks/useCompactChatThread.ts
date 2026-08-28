import { BUILT_IN_CHATS_PROJECT_ID, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import {
  hydrateSelectedThread,
  loadMoreProjectCatalog,
  loadMoreProjectThreadSummaries,
  runBoundedBootstrap,
} from "~/routes/-__root.bounded-bootstrap";
import { useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { useUiStateStore } from "~/stores/ui";
import { newThreadId } from "~/lib/utils";
import { loadProjectForNewThread } from "~/hooks/useHandleNewThread";
import { createSidebarCatalogRefresher } from "~/routes/-__root.sidebar-catalog";
import {
  getCompactChatModelPreference,
  isCompactChatModelPreferenceAvailable,
} from "~/models/compactChatModelPreference";
import { getNewestRecentlyUsedModel } from "~/models/recentlyUsedModels";
import { useDefaultChatCwd, useServerProviders } from "~/rpc/serverState";
import {
  COMPACT_THREAD_STORAGE_KEY,
  parseCompactChatPersistedState,
  serializeCompactChatPersistedState,
  shouldAbandonCompactChatThread,
} from "~/hooks/useCompactChatThread.logic";
import { useCompactChatOwnershipRestoration } from "~/hooks/useCompactChatThread.restore";

function getInitialSelection() {
  return getCompactChatModelPreference() ?? getNewestRecentlyUsedModel();
}

function readStoredCompactChatState() {
  try {
    return parseCompactChatPersistedState(localStorage.getItem(COMPACT_THREAD_STORAGE_KEY));
  } catch {
    return null;
  }
}

function persistCompactChatState(threadId: ThreadId, materialized: boolean): void {
  try {
    localStorage.setItem(
      COMPACT_THREAD_STORAGE_KEY,
      serializeCompactChatPersistedState({ threadId, materialized }),
    );
  } catch {
    // Compact chat remains usable when storage is unavailable.
  }
}

export function useCompactChatThread() {
  const [threadState, setThreadState] = useState(() => {
    const stored = readStoredCompactChatState();
    return {
      projectId: BUILT_IN_CHATS_PROJECT_ID,
      restoring: stored !== null,
      threadId: stored?.threadId ?? newThreadId(),
      persistedMaterialized: stored?.materialized ?? false,
    };
  });
  const { projectId: selectedProjectId, restoring, threadId, persistedMaterialized } = threadState;
  const bootstrapComplete = useStore((state) => state.bootstrapComplete);
  const serverThread = useStore((state) => state.threads.find((thread) => thread.id === threadId));
  const seenOnServerRef = useRef(false);
  // Only the thread id is persisted; use the catalog's project after restoring an existing thread.
  const projectId = serverThread?.projectId ?? selectedProjectId;
  const compactProject = useStore((state) =>
    state.projects.find((project) => project.id === projectId),
  );
  const hydrationStatus = useStore(
    (state) => state.threadHydrationById[threadId]?.status ?? "unloaded",
  );
  const prompt = useComposerDraftStore((state) => state.draftsByThreadId[threadId]?.prompt ?? "");
  const replacementDraftThreadId = useComposerDraftStore(
    (state) => state.projectDraftThreadIdByProjectId[selectedProjectId] ?? null,
  );
  const setDraftThreadContext = useComposerDraftStore((state) => state.setDraftThreadContext);
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const clearDraftThread = useComposerDraftStore((state) => state.clearDraftThread);
  const defaultChatCwd = useDefaultChatCwd();
  const providers = useServerProviders() ?? [];
  const [initialSelection, setInitialSelection] = useState(getInitialSelection);
  const [projectLoadAttempt, setProjectLoadAttempt] = useState(0);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [threadSyncError, setThreadSyncError] = useState<string | null>(null);
  const selectionUnavailable = Boolean(
    initialSelection && !isCompactChatModelPreferenceAvailable(initialSelection, providers),
  );

  useEffect(() => {
    seenOnServerRef.current = false;
  }, [threadId]);

  useEffect(() => {
    if (serverThread && serverThread.deletingAt === null) {
      seenOnServerRef.current = true;
    }
  }, [serverThread]);

  useEffect(() => {
    persistCompactChatState(threadId, serverThread != null && serverThread.deletingAt === null);
  }, [serverThread, threadId]);

  const startFreshThread = useCallback(
    (nextProjectId: ProjectId) => {
      seenOnServerRef.current = false;
      clearDraftThread(threadId);
      setInitialSelection(getInitialSelection());
      setThreadState({
        projectId: nextProjectId,
        restoring: false,
        threadId: newThreadId(),
        persistedMaterialized: false,
      });
    },
    [clearDraftThread, threadId],
  );

  const abandonCurrentThread = useCallback(() => {
    startFreshThread(BUILT_IN_CHATS_PROJECT_ID);
  }, [startFreshThread]);

  useCompactChatOwnershipRestoration({
    abandonCurrentThread,
    bootstrapComplete,
    persistedMaterialized,
    restoring,
    setThreadState,
    setThreadSyncError,
    threadId,
  });

  useEffect(() => {
    if (
      persistedMaterialized ||
      serverThread ||
      !replacementDraftThreadId ||
      replacementDraftThreadId === threadId ||
      useComposerDraftStore.getState().getDraftThread(threadId)
    ) {
      return;
    }
    setThreadState({
      projectId: selectedProjectId,
      restoring: false,
      threadId: replacementDraftThreadId,
      persistedMaterialized: false,
    });
  }, [persistedMaterialized, replacementDraftThreadId, selectedProjectId, serverThread, threadId]);

  useEffect(() => {
    if (restoring) return;
    if (
      shouldAbandonCompactChatThread({
        deleting: serverThread?.deletingAt != null,
        presentOnServer: serverThread !== undefined && serverThread.deletingAt === null,
        seenOnServer: seenOnServerRef.current,
        restoring: false,
        persistedMaterialized,
        hasLocalDraft: Boolean(useComposerDraftStore.getState().getDraftThread(threadId)),
        hydrationFailed: hydrationStatus === "failed",
      })
    ) {
      abandonCurrentThread();
    }
  }, [
    abandonCurrentThread,
    hydrationStatus,
    persistedMaterialized,
    restoring,
    serverThread,
    threadId,
  ]);

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
      projectId,
      getProject: () => useStore.getState().projects.find((project) => project.id === projectId),
      mergeProjectCatalogPage: useStore.getState().mergeProjectCatalogPage,
    })
      .then((project) => {
        if (!disposed && !project) {
          setProjectLoadError("The selected project is unavailable.");
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setProjectLoadError(
            error instanceof Error ? error.message : "The selected project could not be loaded.",
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [bootstrapComplete, compactProject, projectId, projectLoadAttempt, restoring]);

  useEffect(() => {
    if (!bootstrapComplete || restoring || !compactProject || serverThread) return;
    if (seenOnServerRef.current || persistedMaterialized) return;
    setDraftThreadContext(threadId, {
      projectId,
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
    persistedMaterialized,
    restoring,
    serverThread,
    setDraftThreadContext,
    projectId,
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
      serverThread.deletingAt !== null ||
      (hydrationStatus !== "unloaded" && hydrationStatus !== "failed")
    ) {
      return;
    }
    void hydrateSelectedThread({ api, threadId });
  }, [bootstrapComplete, hydrationStatus, restoring, serverThread, threadId]);

  const discardDraft = useCallback(async () => {
    if (prompt.trim().length > 0) {
      const discard = await window.desktopBridge?.confirm("Discard the unsent compact chat draft?");
      if (!discard) return false;
    }
    clearDraftThread(threadId);
    return true;
  }, [clearDraftThread, prompt, threadId]);

  const newChat = useCallback(
    async (nextProjectId = projectId) => {
      if (!(await discardDraft())) return false;
      startFreshThread(nextProjectId);
      return true;
    },
    [discardDraft, projectId, startFreshThread],
  );

  const selectThread = useCallback(
    async (nextThreadId: ThreadId, nextProjectId: ProjectId) => {
      if (nextThreadId === threadId) return true;
      if (!(await discardDraft())) return false;
      useUiStateStore.getState().markThreadVisited(nextThreadId);
      seenOnServerRef.current = false;
      setThreadState({
        projectId: nextProjectId,
        restoring: false,
        threadId: nextThreadId,
        persistedMaterialized: true,
      });
      return true;
    },
    [discardDraft, threadId],
  );

  const loadProjectThreads = useCallback(async (nextProjectId: ProjectId) => {
    const api = readNativeApi();
    if (!api) return;
    await loadMoreProjectThreadSummaries({ api, projectId: nextProjectId });
  }, []);

  const loadMoreProjects = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    await Promise.all([
      ...(["local", "remote"] as const).map((scope) =>
        loadMoreProjectCatalog({ api, scope }).catch(() => undefined),
      ),
      createSidebarCatalogRefresher(api)
        .refresh(() => false)
        .catch(() => undefined),
    ]);
  }, []);

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
    isMaterialized: serverThread != null && serverThread.deletingAt === null,
    loadMoreProjects,
    loadProjectThreads,
    newChat,
    preparing: restoring || (!compactProject && projectLoadError === null),
    projectLoadError,
    projectId,
    projectName: compactProject?.name ?? "Chats",
    retryProjectLoad,
    retryThreadSync,
    selectionUnavailable,
    selectThread,
    synchronizeMaterializedThread,
    threadSyncError,
    threadTitle: serverThread?.title ?? null,
    threadId,
    workspaceRoot: serverThread?.worktreePath ?? compactProject?.cwd ?? defaultChatCwd ?? undefined,
  };
}
