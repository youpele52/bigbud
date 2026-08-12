import {
  BUILT_IN_CHATS_PROJECT_ID,
  DEFAULT_RUNTIME_MODE,
  isBuiltInChatsProject,
  type GetStartupProjectCatalogResult,
  type NativeApi,
  type ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useComposerDraftStore } from "../stores/composer";
import { type DraftThreadEnvMode, type DraftThreadState } from "../stores/composer";
import { newThreadId } from "../lib/utils";
import { resolveWorkspaceExecutionTargetId } from "../lib/providerExecutionTargets";
import { orderItemsByPreferredIds } from "../components/sidebar/Sidebar.logic";
import { useRemoteExecutionAccessGate } from "./useRemoteExecutionAccessGate";
import { useStore } from "../stores/main";
import { useThreadById } from "../stores/main";
import { useUiStateStore } from "../stores/ui";
import type { Project } from "../models/types";
import { readNativeApi } from "../rpc/nativeApi";
import { toastManager } from "../components/ui/toast";

const pendingProjectLoads = new Map<ProjectId, Promise<Project | undefined>>();

export async function loadProjectForNewThread(input: {
  api: Pick<NativeApi, "orchestration">;
  projectId: ProjectId;
  getProject: () => Project | undefined;
  mergeProjectCatalogPage: (page: GetStartupProjectCatalogResult) => void;
}): Promise<Project | undefined> {
  const existingProject = input.getProject();
  if (existingProject) {
    return existingProject;
  }

  const pendingLoad = pendingProjectLoads.get(input.projectId);
  if (pendingLoad) {
    return pendingLoad;
  }

  const load = Promise.allSettled(
    (["local", "remote"] as const).map((scope) =>
      input.api.orchestration.getStartupProjectCatalog({
        scope,
        limit: 1,
        priorityProjectId: input.projectId,
      }),
    ),
  )
    .then((results) => {
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const page = result.value;
        if (page.projects.some((candidate) => candidate.id === input.projectId)) {
          input.mergeProjectCatalogPage(page);
        }
      }
      const loadedProject = input.getProject();
      if (loadedProject) return loadedProject;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length === results.length) {
        throw failures[0]!.reason;
      }
      return undefined;
    })
    .finally(() => {
      pendingProjectLoads.delete(input.projectId);
    });
  pendingProjectLoads.set(input.projectId, load);
  return load;
}

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
  const projects = useStore((store) => store.projects);
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects]);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const navigate = useNavigate();
  const { beginRemoteExecutionTargetAccessCheck } = useRemoteExecutionAccessGate();
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
      const getProject = () =>
        useStore.getState().projects.find((projectEntry) => projectEntry.id === projectId);
      const loadedProject = getProject();
      const api = loadedProject ? null : readNativeApi();
      if (!loadedProject && !api) {
        toastManager.add({
          type: "error",
          title: "Could not start a new thread",
          description: "bigbud is not connected to the server.",
        });
        return Promise.resolve();
      }
      const loadProject = loadedProject
        ? Promise.resolve(loadedProject)
        : loadProjectForNewThread({
            api: api!,
            projectId,
            getProject,
            mergeProjectCatalogPage: useStore.getState().mergeProjectCatalogPage,
          });
      const hasBranchOption = normalizedOptions?.branch !== undefined;
      const hasWorktreePathOption = normalizedOptions?.worktreePath !== undefined;
      const hasEnvModeOption = normalizedOptions?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      const latestActiveDraftThread: DraftThreadState | null = routeThreadId
        ? getDraftThread(routeThreadId)
        : null;
      const ensureProjectRemoteAccess = async () => {
        const project = await loadProject.catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not start a new thread",
            description:
              error instanceof Error ? error.message : "The project could not be loaded.",
          });
          return null;
        });
        if (project === null) {
          return false;
        }
        if (!project) {
          toastManager.add({
            type: "error",
            title: "Could not start a new thread",
            description: "The project is unavailable.",
          });
          return false;
        }

        return beginRemoteExecutionTargetAccessCheck({
          executionTargetId: resolveWorkspaceExecutionTargetId(project),
          ...(project.cwd ? { cwd: project.cwd } : {}),
          onVerified: () => handleNewThread(projectId, normalizedOptions),
          resumeOnUnlockOnly: true,
        });
      };
      if (storedDraftThread) {
        return (async () => {
          if (!(await ensureProjectRemoteAccess())) {
            return;
          }
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

      if (
        latestActiveDraftThread &&
        routeThreadId &&
        latestActiveDraftThread.projectId === projectId &&
        !useStore.getState().threads.find((t) => t.id === routeThreadId)
      ) {
        return (async () => {
          if (!(await ensureProjectRemoteAccess())) {
            return;
          }

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
        })();
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        if (!(await ensureProjectRemoteAccess())) {
          return;
        }
        const concurrentlyCreatedDraft = getDraftThreadByProjectId(projectId);
        if (concurrentlyCreatedDraft) {
          setProjectDraftThreadId(projectId, concurrentlyCreatedDraft.threadId);
          if (routeThreadId !== concurrentlyCreatedDraft.threadId) {
            await navigate({
              to: "/$threadId",
              params: { threadId: concurrentlyCreatedDraft.threadId },
            });
          }
          return;
        }
        clearProjectDraftThreadId(projectId);
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
    [beginRemoteExecutionTargetAccessCheck, navigate, routeThreadId],
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
