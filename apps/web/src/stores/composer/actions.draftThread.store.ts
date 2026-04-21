import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@bigbud/contracts";
import type { StoreApi } from "zustand";
import { revokeObjectPreviewUrl } from "./normalization.store";
import {
  type ComposerDraftStoreState,
  type DraftThreadEnvMode,
  type DraftThreadState,
} from "./types.store";

type SetFn = StoreApi<ComposerDraftStoreState>["setState"];
type GetFn = StoreApi<ComposerDraftStoreState>["getState"];

/** Draft-thread lifecycle actions: create, update, and remove per-project thread drafts. */
export function createDraftThreadActions(set: SetFn, get: GetFn) {
  return {
    getDraftThreadByProjectId: (projectId: ProjectId) => {
      if (projectId.length === 0) {
        return null;
      }
      const threadId = get().projectDraftThreadIdByProjectId[projectId];
      if (!threadId) {
        return null;
      }
      const draftThread = get().draftThreadsByThreadId[threadId];
      if (!draftThread || draftThread.projectId !== projectId) {
        return null;
      }
      return {
        threadId,
        ...draftThread,
      };
    },
    getDraftThread: (threadId: ThreadId) => {
      if (threadId.length === 0) {
        return null;
      }
      return get().draftThreadsByThreadId[threadId] ?? null;
    },
    setProjectDraftThreadId: (
      projectId: ProjectId,
      threadId: ThreadId,
      options?: {
        worktreePath?: string | null;
        createdAt?: string;
        runtimeMode?: RuntimeMode;
        interactionMode?: ProviderInteractionMode;
        branch?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ) => {
      if (projectId.length === 0 || threadId.length === 0) {
        return;
      }
      set((state) => {
        const existingThread = state.draftThreadsByThreadId[threadId];
        const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[projectId];
        const nextWorktreePath =
          options?.worktreePath === undefined
            ? (existingThread?.worktreePath ?? null)
            : (options.worktreePath ?? null);
        const nextDraftThread: DraftThreadState = {
          projectId,
          createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
          runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode:
            options?.interactionMode ??
            existingThread?.interactionMode ??
            DEFAULT_PROVIDER_INTERACTION_MODE,
          branch:
            options?.branch === undefined
              ? (existingThread?.branch ?? null)
              : (options.branch ?? null),
          worktreePath: nextWorktreePath,
          envMode:
            options?.envMode ??
            (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
        };
        const hasSameProjectMapping = previousThreadIdForProject === threadId;
        const hasSameDraftThread =
          existingThread &&
          existingThread.projectId === nextDraftThread.projectId &&
          existingThread.createdAt === nextDraftThread.createdAt &&
          existingThread.runtimeMode === nextDraftThread.runtimeMode &&
          existingThread.interactionMode === nextDraftThread.interactionMode &&
          existingThread.branch === nextDraftThread.branch &&
          existingThread.worktreePath === nextDraftThread.worktreePath &&
          existingThread.envMode === nextDraftThread.envMode;
        if (hasSameProjectMapping && hasSameDraftThread) {
          return state;
        }
        const nextProjectDraftThreadIdByProjectId: Record<ProjectId, ThreadId> = {
          ...state.projectDraftThreadIdByProjectId,
          [projectId]: threadId,
        };
        const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
          ...state.draftThreadsByThreadId,
          [threadId]: nextDraftThread,
        };
        let nextDraftsByThreadId = state.draftsByThreadId;
        if (
          previousThreadIdForProject &&
          previousThreadIdForProject !== threadId &&
          !Object.values(nextProjectDraftThreadIdByProjectId).includes(previousThreadIdForProject)
        ) {
          delete nextDraftThreadsByThreadId[previousThreadIdForProject];
          if (state.draftsByThreadId[previousThreadIdForProject] !== undefined) {
            nextDraftsByThreadId = { ...state.draftsByThreadId };
            delete nextDraftsByThreadId[previousThreadIdForProject];
          }
        }
        return {
          draftsByThreadId: nextDraftsByThreadId,
          draftThreadsByThreadId: nextDraftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    setDraftThreadContext: (
      threadId: ThreadId,
      options: {
        projectId?: ProjectId;
        createdAt?: string;
        runtimeMode?: RuntimeMode;
        interactionMode?: ProviderInteractionMode;
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadId[threadId];
        if (!existing) {
          return state;
        }
        const nextProjectId = options.projectId ?? existing.projectId;
        if (nextProjectId.length === 0) {
          return state;
        }
        const nextWorktreePath =
          options.worktreePath === undefined
            ? existing.worktreePath
            : (options.worktreePath ?? null);
        const nextDraftThread: DraftThreadState = {
          projectId: nextProjectId,
          createdAt:
            options.createdAt === undefined
              ? existing.createdAt
              : options.createdAt || existing.createdAt,
          runtimeMode: options.runtimeMode ?? existing.runtimeMode,
          interactionMode: options.interactionMode ?? existing.interactionMode,
          branch: options.branch === undefined ? existing.branch : (options.branch ?? null),
          worktreePath: nextWorktreePath,
          envMode:
            options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
        };
        const isUnchanged =
          nextDraftThread.projectId === existing.projectId &&
          nextDraftThread.createdAt === existing.createdAt &&
          nextDraftThread.runtimeMode === existing.runtimeMode &&
          nextDraftThread.interactionMode === existing.interactionMode &&
          nextDraftThread.branch === existing.branch &&
          nextDraftThread.worktreePath === existing.worktreePath &&
          nextDraftThread.envMode === existing.envMode;
        if (isUnchanged) {
          return state;
        }
        const nextProjectDraftThreadIdByProjectId: Record<ProjectId, ThreadId> = {
          ...state.projectDraftThreadIdByProjectId,
          [nextProjectId]: threadId,
        };
        if (existing.projectId !== nextProjectId) {
          if (nextProjectDraftThreadIdByProjectId[existing.projectId] === threadId) {
            delete nextProjectDraftThreadIdByProjectId[existing.projectId];
          }
        }
        return {
          draftThreadsByThreadId: {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          },
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    clearProjectDraftThreadId: (projectId: ProjectId) => {
      if (projectId.length === 0) {
        return;
      }
      set((state) => {
        const threadId = state.projectDraftThreadIdByProjectId[projectId];
        if (threadId === undefined) {
          return state;
        }
        const { [projectId]: _removed, ...restProjectMappingsRaw } =
          state.projectDraftThreadIdByProjectId;
        const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
        const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
          ...state.draftThreadsByThreadId,
        };
        let nextDraftsByThreadId = state.draftsByThreadId;
        if (!Object.values(restProjectMappings).includes(threadId)) {
          delete nextDraftThreadsByThreadId[threadId];
          if (state.draftsByThreadId[threadId] !== undefined) {
            nextDraftsByThreadId = { ...state.draftsByThreadId };
            delete nextDraftsByThreadId[threadId];
          }
        }
        return {
          draftsByThreadId: nextDraftsByThreadId,
          draftThreadsByThreadId: nextDraftThreadsByThreadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
        };
      });
    },
    clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => {
      if (projectId.length === 0 || threadId.length === 0) {
        return;
      }
      set((state) => {
        if (state.projectDraftThreadIdByProjectId[projectId] !== threadId) {
          return state;
        }
        const { [projectId]: _removed, ...restProjectMappingsRaw } =
          state.projectDraftThreadIdByProjectId;
        const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
        const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
          ...state.draftThreadsByThreadId,
        };
        let nextDraftsByThreadId = state.draftsByThreadId;
        if (!Object.values(restProjectMappings).includes(threadId)) {
          delete nextDraftThreadsByThreadId[threadId];
          if (state.draftsByThreadId[threadId] !== undefined) {
            nextDraftsByThreadId = { ...state.draftsByThreadId };
            delete nextDraftsByThreadId[threadId];
          }
        }
        return {
          draftsByThreadId: nextDraftsByThreadId,
          draftThreadsByThreadId: nextDraftThreadsByThreadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
        };
      });
    },
    clearDraftThread: (threadId: ThreadId) => {
      if (threadId.length === 0) {
        return;
      }
      const existing = get().draftsByThreadId[threadId];
      if (existing) {
        for (const image of existing.images) {
          revokeObjectPreviewUrl(image.previewUrl);
        }
      }
      set((state) => {
        const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
        const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
          threadId,
        );
        const hasComposerDraft = state.draftsByThreadId[threadId] !== undefined;
        if (!hasDraftThread && !hasProjectMapping && !hasComposerDraft) {
          return state;
        }
        const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
          Object.entries(state.projectDraftThreadIdByProjectId).filter(
            ([, draftThreadId]) => draftThreadId !== threadId,
          ),
        ) as Record<ProjectId, ThreadId>;
        const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
          state.draftThreadsByThreadId;
        const { [threadId]: _removedComposerDraft, ...restDraftsByThreadId } =
          state.draftsByThreadId;
        return {
          draftsByThreadId: restDraftsByThreadId,
          draftThreadsByThreadId: restDraftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
  };
}
