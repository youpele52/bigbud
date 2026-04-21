import {
  BUILT_IN_CHATS_PROJECT_ID,
  DEFAULT_RUNTIME_MODE,
  isBuiltInChatsProject,
  type ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useComposerDraftStore } from "../stores/composer";
import { type DraftThreadEnvMode, type DraftThreadState } from "../stores/composer";
import { newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/sidebar/Sidebar.logic";
import { useStore } from "../stores/main";
import { useThreadById } from "../stores/main";
import { useUiStateStore } from "../stores/ui";

export function resolveContextualNewThreadOptions(input: {
  activeDraftThread:
    | {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      }
    | null
    | undefined;
  activeThread:
    | {
        branch?: string | null;
        worktreePath?: string | null;
      }
    | null
    | undefined;
}): {
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
} {
  return {
    branch: input.activeThread?.branch ?? input.activeDraftThread?.branch ?? null,
    worktreePath: input.activeThread?.worktreePath ?? input.activeDraftThread?.worktreePath ?? null,
    envMode:
      input.activeDraftThread?.envMode ?? (input.activeThread?.worktreePath ? "worktree" : "local"),
  };
}

export function resolveNewChatOptions(): {
  branch: null;
  worktreePath: null;
  envMode: "local";
} {
  return {
    branch: null,
    worktreePath: null,
    envMode: "local",
  };
}

export function useHandleNewThread() {
  const projectIds = useStore(useShallow((store) => store.projects.map((project) => project.id)));
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeThread = useThreadById(routeThreadId);
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projectIds,
      preferredIds: projectOrder,
      getId: (projectId) => projectId,
    });
  }, [projectIds, projectOrder]);

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const normalizedOptions = isBuiltInChatsProject(projectId)
        ? resolveNewChatOptions()
        : options;
      const {
        clearProjectDraftThreadId,
        getDraftThread,
        getDraftThreadByProjectId,
        applyStickyState,
        setDraftThreadContext,
        setProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const hasBranchOption = normalizedOptions?.branch !== undefined;
      const hasWorktreePathOption = normalizedOptions?.worktreePath !== undefined;
      const hasEnvModeOption = normalizedOptions?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      const latestActiveDraftThread: DraftThreadState | null = routeThreadId
        ? getDraftThread(routeThreadId)
        : null;
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.threadId, {
              ...(hasBranchOption ? { branch: normalizedOptions?.branch ?? null } : {}),
              ...(hasWorktreePathOption
                ? { worktreePath: normalizedOptions?.worktreePath ?? null }
                : {}),
              ...(hasEnvModeOption ? { envMode: normalizedOptions?.envMode } : {}),
            });
          }
          setProjectDraftThreadId(projectId, storedDraftThread.threadId);
          if (routeThreadId === storedDraftThread.threadId) {
            return;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        })();
      }

      clearProjectDraftThreadId(projectId);

      if (
        latestActiveDraftThread &&
        routeThreadId &&
        latestActiveDraftThread.projectId === projectId &&
        !useStore.getState().threads.find((t) => t.id === routeThreadId)
      ) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: normalizedOptions?.branch ?? null } : {}),
            ...(hasWorktreePathOption
              ? { worktreePath: normalizedOptions?.worktreePath ?? null }
              : {}),
            ...(hasEnvModeOption ? { envMode: normalizedOptions?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return Promise.resolve();
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setProjectDraftThreadId(projectId, threadId, {
          createdAt,
          branch: normalizedOptions?.branch ?? null,
          worktreePath: normalizedOptions?.worktreePath ?? null,
          envMode: normalizedOptions?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        applyStickyState(threadId);

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [navigate, routeThreadId],
  );

  return {
    activeDraftThread,
    activeThread,
    defaultProjectId:
      orderedProjects.find((projectId) => isBuiltInChatsProject(projectId)) ??
      orderedProjects[0] ??
      null,
    chatsProjectId: projectIds.find((projectId) => projectId === BUILT_IN_CHATS_PROJECT_ID) ?? null,
    handleNewThread,
    routeThreadId,
  };
}
