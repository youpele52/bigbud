import { BUILT_IN_CHATS_PROJECT_ID, type ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useState } from "react";

import { useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { newThreadId } from "~/lib/utils";
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
  const [threadId, setThreadId] = useState<ThreadId>(() => readStoredThreadId() ?? newThreadId());
  const serverThread = useStore((state) => state.threads.find((thread) => thread.id === threadId));
  const prompt = useComposerDraftStore((state) => state.draftsByThreadId[threadId]?.prompt ?? "");
  const setDraftThreadContext = useComposerDraftStore((state) => state.setDraftThreadContext);
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const clearDraftThread = useComposerDraftStore((state) => state.clearDraftThread);
  const providers = useServerProviders() ?? [];
  const [initialSelection, setInitialSelection] = useState(getInitialSelection);
  const selectionUnavailable = Boolean(
    initialSelection && !isCompactChatModelPreferenceAvailable(initialSelection, providers),
  );

  useEffect(() => {
    persistThreadId(threadId);
    if (!serverThread) {
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
    }
  }, [initialSelection, serverThread, setDraftThreadContext, setModelSelection, threadId]);

  const newChat = useCallback(async () => {
    if (prompt.trim().length > 0) {
      const discard = await window.desktopBridge?.confirm("Discard the unsent compact chat draft?");
      if (!discard) return false;
    }
    clearDraftThread(threadId);
    setInitialSelection(getInitialSelection());
    setThreadId(newThreadId());
    return true;
  }, [clearDraftThread, prompt, threadId]);

  return { isMaterialized: Boolean(serverThread), newChat, selectionUnavailable, threadId };
}
