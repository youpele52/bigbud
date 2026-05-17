import { ThreadId, type ModelSelection } from "@bigbud/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/sidebar/Sidebar.logic";
import { useComposerDraftStore } from "../stores/composer";
import { useHandleNewThread } from "./useHandleNewThread";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import { buildExplicitExecutionTargets } from "../lib/providerExecutionTargets";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../rpc/nativeApi";
import { useStore } from "../stores/main";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../utils/worktree";
import { toastManager } from "../components/ui/toast";
import { useSettings } from "./useSettings";
import { prepareSeedMessages } from "../lib/threadFork";
import {
  waitForThreadToDisappear,
  waitForThreadToExist,
} from "../components/chat/view/ChatView.logic";

const FORK_TITLE_SUFFIX_PATTERN = /\s+\(([A-Z]+)\)$/;

function decodeAlphaSuffix(value: string): number {
  let result = 0;
  for (const char of value) {
    result = result * 26 + (char.charCodeAt(0) - 64);
  }
  return result;
}

function encodeAlphaSuffix(value: number): string {
  let remaining = value;
  let result = "";
  while (remaining > 0) {
    const index = (remaining - 1) % 26;
    result = String.fromCharCode(65 + index) + result;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return result;
}

export function buildForkThreadTitle(
  sourceTitle: string,
  siblingTitles: ReadonlyArray<string>,
): string {
  const trimmedSourceTitle = sourceTitle.trim();
  const match = FORK_TITLE_SUFFIX_PATTERN.exec(trimmedSourceTitle);
  const baseTitle = (match ? trimmedSourceTitle.slice(0, match.index) : trimmedSourceTitle).trim();
  const normalizedBaseTitle = baseTitle.length > 0 ? baseTitle : "New thread";

  let highestSuffixIndex = 0;
  for (const title of siblingTitles) {
    const trimmedTitle = title.trim();
    if (trimmedTitle === normalizedBaseTitle) {
      highestSuffixIndex = Math.max(highestSuffixIndex, 0);
      continue;
    }
    const siblingMatch = FORK_TITLE_SUFFIX_PATTERN.exec(trimmedTitle);
    if (!siblingMatch) {
      continue;
    }
    const siblingBaseTitle = trimmedTitle.slice(0, siblingMatch.index).trim();
    if (siblingBaseTitle !== normalizedBaseTitle) {
      continue;
    }
    highestSuffixIndex = Math.max(highestSuffixIndex, decodeAlphaSuffix(siblingMatch[1] ?? ""));
  }

  return `${normalizedBaseTitle} (${encodeAlphaSuffix(highestSuffixIndex + 1)})`;
}

export function useThreadActions() {
  const appSettings = useSettings();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  // Keep a ref so archiveThread can read the latest handleNewThread without
  // appearing in its dependency array. handleNewThread is inherently unstable
  // (depends on the projects list) and would otherwise cascade new references
  // into every sidebar row via archiveThread.
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));

  const archiveThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        throw new Error("Cannot archive a running thread.");
      }

      await api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId,
      });

      if (routeThreadId === threadId) {
        await handleNewThreadRef.current(thread.projectId);
      }
    },
    [routeThreadId],
  );

  const unarchiveThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId,
    });
  }, []);

  const deleteThread = useCallback(
    async (threadId: ThreadId, opts: { deletedThreadIds?: ReadonlySet<ThreadId> } = {}) => {
      const api = readNativeApi();
      if (!api) return;
      const { projects, threads } = useStore.getState();
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const threadProject = projects.find((project) => project.id === thread.projectId);
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((entry) => entry.id === threadId || !deletedIds.has(entry.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree =
        orphanedWorktreePath !== null && threadProject !== undefined && threadProject.cwd !== null;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      const deletedThreadIds = opts.deletedThreadIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadId,
        deletedThreadIds,
        sortOrder: appSettings.sidebarThreadSortOrder,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });

      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          await navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      const deleted = await waitForThreadToDisappear(threadId);
      if (!deleted) {
        toastManager.add({
          type: "warning",
          title: "Skipping worktree removal",
          description:
            "Thread deletion is still in progress. Worktree removal was skipped to avoid removing files before cleanup finished.",
        });
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd!,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [appSettings.sidebarThreadSortOrder, navigate, removeWorktreeMutation, routeThreadId],
  );

  const forkThread = useCallback(
    async (
      sourceThreadId: ThreadId,
      options?: {
        modelSelection?: ModelSelection;
        navigateToFork?: boolean;
      },
    ) => {
      const api = readNativeApi();
      if (!api) return null;

      const threads = useStore.getState().threads;
      const sourceThread = threads.find((entry) => entry.id === sourceThreadId);
      if (!sourceThread) {
        toastManager.add({
          type: "error",
          title: "Cannot fork thread",
          description: "Source thread not found.",
        });
        return null;
      }

      const forkedThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      const seedMessages = prepareSeedMessages(sourceThread.messages);
      const forkedThreadTitle = buildForkThreadTitle(
        sourceThread.title,
        threads
          .filter((entry) => entry.projectId === sourceThread.projectId)
          .map((entry) => entry.title),
      );

      try {
        const executionTargets = buildExplicitExecutionTargets({
          providerRuntimeExecutionTargetId: sourceThread.providerRuntimeExecutionTargetId,
          workspaceExecutionTargetId: sourceThread.workspaceExecutionTargetId,
        });
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: forkedThreadId,
          projectId: sourceThread.projectId,
          title: forkedThreadTitle,
          ...executionTargets,
          modelSelection: options?.modelSelection ?? sourceThread.modelSelection,
          runtimeMode: sourceThread.runtimeMode,
          interactionMode: sourceThread.interactionMode,
          branch: sourceThread.branch,
          worktreePath: sourceThread.worktreePath,
          parentThread: {
            threadId: sourceThreadId,
            title: sourceThread.title,
          },
          seedMessages,
          createdAt,
        });
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "Failed to fork thread",
          description: err instanceof Error ? err.message : "Could not create forked thread.",
        });
        return null;
      }

      const store = useComposerDraftStore.getState();
      const sourceDraft = store.draftsByThreadId[sourceThreadId];
      if (sourceDraft) {
        store.setPrompt(forkedThreadId, sourceDraft.prompt);

        for (const [_provider, selection] of Object.entries(sourceDraft.modelSelectionByProvider)) {
          if (selection) {
            store.setModelSelection(forkedThreadId, selection);
          }
        }

        if (options?.modelSelection) {
          store.setModelSelection(forkedThreadId, options.modelSelection);
        }

        store.setRuntimeMode(forkedThreadId, sourceDraft.runtimeMode);
        store.setInteractionMode(forkedThreadId, sourceDraft.interactionMode);

        if (sourceDraft.images.length > 0) {
          store.addImages(forkedThreadId, sourceDraft.images);
        }

        if (sourceDraft.terminalContexts.length > 0) {
          const updatedContexts = sourceDraft.terminalContexts.map((context) => {
            const updated = context;
            updated.threadId = forkedThreadId;
            return updated;
          });
          store.setTerminalContexts(forkedThreadId, updatedContexts);
        }
      }

      useComposerDraftStore.getState().setBootstrapSourceThreadId(forkedThreadId, sourceThreadId);

      const threadExists = await waitForThreadToExist(forkedThreadId);
      if (!threadExists) {
        toastManager.add({
          type: "error",
          title: "Fork created but not visible",
          description: "The forked thread was created but did not appear in time.",
        });
        return forkedThreadId;
      }

      if (options?.navigateToFork !== false) {
        await navigate({
          to: "/$threadId",
          params: { threadId: forkedThreadId },
        });
      }

      toastManager.add({
        type: "success",
        title: "Thread forked",
      });

      return forkedThreadId;
    },
    [navigate],
  );

  return {
    archiveThread,
    unarchiveThread,
    deleteThread,
    forkThread,
  };
}
