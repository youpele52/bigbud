import { type OrchestrationEvent } from "@bigbud/contracts";
import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant";

import {
  buildSidebarThreadSummary,
  mapProject,
  mapProjectScripts,
  mapThread,
  normalizeModelSlug,
  sidebarThreadSummariesEqual,
} from "./mappers.store";
import { type AppState } from "./main.store";
import {
  appendThreadIdByProjectId,
  removeThreadIdByProjectId,
  updateProject,
} from "./helpers.store";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { prependSidebarRecentThreadId, removeSidebarThreadId } from "./helpers.sidebar.store";
import { applyActiveThreadCountTransition } from "./helpers.projectThreadCount.store";
import type { Project } from "../../models/types";

function recordProjectEventSequence(state: AppState, projectId: string, sequence: number) {
  return {
    ...state.latestProjectEventSequenceById,
    [projectId]: Math.max(state.latestProjectEventSequenceById?.[projectId] ?? 0, sequence),
  };
}

function recordProjectDeletionSequence(state: AppState, projectId: string, sequence: number) {
  return {
    ...state.deletedProjectSequenceById,
    [projectId]: Math.max(state.deletedProjectSequenceById?.[projectId] ?? 0, sequence),
  };
}

function clearProjectDeletionSequence(state: AppState, projectId: string, sequence: number) {
  const deletionSequence = state.deletedProjectSequenceById?.[projectId];
  if (deletionSequence === undefined || deletionSequence > sequence) {
    return state.deletedProjectSequenceById ?? {};
  }

  const deletedProjectSequenceById = { ...state.deletedProjectSequenceById };
  delete deletedProjectSequenceById[projectId];
  return deletedProjectSequenceById;
}

function recordPendingUnloadedProjectPatch(
  state: AppState,
  projectId: string,
  sequence: number,
  patch: Partial<Omit<Project, "id">>,
) {
  const pendingPatches = state.pendingUnloadedProjectPatchById ?? {};
  if (state.projects.some((project) => project.id === projectId)) {
    return pendingPatches;
  }

  const existing = pendingPatches[projectId];
  if (existing && existing.sequence > sequence) {
    return pendingPatches;
  }

  return {
    ...pendingPatches,
    [projectId]: {
      sequence,
      patch: { ...existing?.patch, ...patch },
    },
  };
}

function clearPendingUnloadedProjectPatch(state: AppState, projectId: string) {
  if (!state.pendingUnloadedProjectPatchById?.[projectId]) {
    return state.pendingUnloadedProjectPatchById ?? {};
  }

  const pendingPatches = { ...state.pendingUnloadedProjectPatchById };
  delete pendingPatches[projectId];
  return pendingPatches;
}

export function applyProjectEvent(
  state: AppState,
  event: OrchestrationEvent,
): AppState | undefined {
  switch (event.type) {
    case "project.created": {
      const existingIndex = state.projects.findIndex(
        (project) =>
          project.id === event.payload.projectId ||
          (project.cwd !== null &&
            event.payload.workspaceRoot !== null &&
            project.cwd === event.payload.workspaceRoot &&
            resolveWorkspaceExecutionTargetId(project) ===
              resolveWorkspaceExecutionTargetId(event.payload)),
      );
      const nextProject = mapProject({
        id: event.payload.projectId,
        title: event.payload.title,
        providerRuntimeExecutionTargetId: event.payload.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: event.payload.workspaceExecutionTargetId,
        executionTargetId: event.payload.executionTargetId,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        scripts: event.payload.scripts,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        deletingAt: null,
        deletedAt: null,
      });
      const activeThreadCount =
        existingIndex >= 0 && state.projects[existingIndex]?.id === nextProject.id
          ? state.projects[existingIndex]?.activeThreadCount
          : 0;
      const projectWithThreadCount = {
        ...nextProject,
        ...(activeThreadCount === undefined ? {} : { activeThreadCount }),
      };
      const projects =
        existingIndex >= 0
          ? state.projects.map((project, index) =>
              index === existingIndex ? projectWithThreadCount : project,
            )
          : [...state.projects, projectWithThreadCount];
      return {
        ...state,
        projects,
        latestProjectEventSequenceById: recordProjectEventSequence(
          state,
          event.payload.projectId,
          event.sequence,
        ),
        deletedProjectSequenceById: clearProjectDeletionSequence(
          state,
          event.payload.projectId,
          event.sequence,
        ),
        pendingUnloadedProjectPatchById: clearPendingUnloadedProjectPatch(
          state,
          event.payload.projectId,
        ),
      };
    }

    case "project.meta-updated": {
      const patch: Partial<Omit<Project, "id">> = {
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.providerRuntimeExecutionTargetId !== undefined
          ? { providerRuntimeExecutionTargetId: event.payload.providerRuntimeExecutionTargetId }
          : {}),
        ...(event.payload.workspaceExecutionTargetId !== undefined
          ? { workspaceExecutionTargetId: event.payload.workspaceExecutionTargetId }
          : {}),
        ...(event.payload.executionTargetId !== undefined
          ? { executionTargetId: event.payload.executionTargetId }
          : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? normalizeModelSlug(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        updatedAt: event.payload.updatedAt,
      };
      const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
        ...project,
        ...patch,
      }));
      return {
        ...state,
        projects,
        latestProjectEventSequenceById: recordProjectEventSequence(
          state,
          event.payload.projectId,
          event.sequence,
        ),
        pendingUnloadedProjectPatchById: recordPendingUnloadedProjectPatch(
          state,
          event.payload.projectId,
          event.sequence,
          patch,
        ),
      };
    }

    case "project.deletion-requested": {
      const patch = {
        deletingAt: event.payload.deletingAt,
        updatedAt: event.payload.deletingAt,
      };
      return {
        ...state,
        projects: updateProject(state.projects, event.payload.projectId, (project) => ({
          ...project,
          ...patch,
        })),
        latestProjectEventSequenceById: recordProjectEventSequence(
          state,
          event.payload.projectId,
          event.sequence,
        ),
        pendingUnloadedProjectPatchById: recordPendingUnloadedProjectPatch(
          state,
          event.payload.projectId,
          event.sequence,
          patch,
        ),
      };
    }

    case "project.deletion-failed": {
      const patch = { deletingAt: null, updatedAt: event.payload.updatedAt };
      return {
        ...state,
        projects: updateProject(state.projects, event.payload.projectId, (project) => ({
          ...project,
          ...patch,
        })),
        latestProjectEventSequenceById: recordProjectEventSequence(
          state,
          event.payload.projectId,
          event.sequence,
        ),
        pendingUnloadedProjectPatchById: recordPendingUnloadedProjectPatch(
          state,
          event.payload.projectId,
          event.sequence,
          patch,
        ),
      };
    }

    case "project.deleted": {
      const projects = state.projects.filter((project) => project.id !== event.payload.projectId);
      return {
        ...state,
        projects,
        latestProjectEventSequenceById: recordProjectEventSequence(
          state,
          event.payload.projectId,
          event.sequence,
        ),
        deletedProjectSequenceById: recordProjectDeletionSequence(
          state,
          event.payload.projectId,
          event.sequence,
        ),
        pendingUnloadedProjectPatchById: clearPendingUnloadedProjectPatch(
          state,
          event.payload.projectId,
        ),
      };
    }

    case "thread.created": {
      const existing = state.threads.find((thread) => thread.id === event.payload.threadId);
      const nextThread = mapProjectThread(event);
      const projects = applyActiveThreadCountTransition(state.projects, existing, nextThread);
      const threads = existing
        ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
        : [...state.threads, nextThread];
      if (nextThread.purpose === "side-chat") {
        return { ...state, projects, threads };
      }
      const nextSummary = buildSidebarThreadSummary(nextThread);
      const previousSummary = state.sidebarThreadsById[nextThread.id];
      const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
        ? state.sidebarThreadsById
        : {
            ...state.sidebarThreadsById,
            [nextThread.id]: nextSummary,
          };
      const nextThreadIdsByProjectId =
        existing !== undefined && existing.projectId !== nextThread.projectId
          ? removeThreadIdByProjectId(state.threadIdsByProjectId, existing.projectId, existing.id)
          : state.threadIdsByProjectId;
      const threadIdsByProjectId = appendThreadIdByProjectId(
        nextThreadIdsByProjectId,
        nextThread.projectId,
        nextThread.id,
      );
      return {
        ...state,
        projects,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
        sidebarRecentThreadIds: isBuiltInChatsProject(nextThread.projectId)
          ? prependSidebarRecentThreadId(state.sidebarRecentThreadIds, nextThread.id)
          : state.sidebarRecentThreadIds,
      };
    }

    case "thread.deleted": {
      const threads = state.threads.filter((thread) => thread.id !== event.payload.threadId);
      const hadHydration = Object.hasOwn(state.threadHydrationById, event.payload.threadId);
      if (threads.length === state.threads.length && !hadHydration) {
        return state;
      }
      const deletedThread = state.threads.find((thread) => thread.id === event.payload.threadId);
      const projects = applyActiveThreadCountTransition(state.projects, deletedThread, undefined);
      const sidebarThreadsById = { ...state.sidebarThreadsById };
      delete sidebarThreadsById[event.payload.threadId];
      const threadHydrationById = { ...state.threadHydrationById };
      delete threadHydrationById[event.payload.threadId];
      const threadIdsByProjectId = deletedThread
        ? removeThreadIdByProjectId(
            state.threadIdsByProjectId,
            deletedThread.projectId,
            deletedThread.id,
          )
        : state.threadIdsByProjectId;
      return {
        ...state,
        projects,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
        threadHydrationById,
        sidebarRecentThreadIds: removeSidebarThreadId(
          state.sidebarRecentThreadIds,
          event.payload.threadId,
        ),
        sidebarPinnedThreadIds: removeSidebarThreadId(
          state.sidebarPinnedThreadIds,
          event.payload.threadId,
        ),
      };
    }

    default:
      return undefined;
  }
}

function mapProjectThread(event: Extract<OrchestrationEvent, { type: "thread.created" }>) {
  return mapThread({
    id: event.payload.threadId,
    projectId: event.payload.projectId,
    title: event.payload.title,
    purpose: event.payload.purpose ?? "standard",
    elevatorSummary: event.payload.title,
    elevatorSummaryMessageCount: 0,
    providerRuntimeExecutionTargetId: event.payload.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: event.payload.workspaceExecutionTargetId,
    executionTargetId: event.payload.executionTargetId,
    modelSelection: event.payload.modelSelection,
    runtimeMode: event.payload.runtimeMode,
    interactionMode: event.payload.interactionMode,
    branch: event.payload.branch,
    worktreePath: event.payload.worktreePath,
    latestTurn: null,
    createdAt: event.payload.createdAt,
    updatedAt: event.payload.updatedAt,
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
  });
}
