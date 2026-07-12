import { type OrchestrationEvent } from "@bigbud/contracts";

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
      const projects =
        existingIndex >= 0
          ? state.projects.map((project, index) =>
              index === existingIndex ? nextProject : project,
            )
          : [...state.projects, nextProject];
      return { ...state, projects };
    }

    case "project.meta-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
        ...project,
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
      }));
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.deleted": {
      const projects = state.projects.filter((project) => project.id !== event.payload.projectId);
      return projects.length === state.projects.length ? state : { ...state, projects };
    }

    case "thread.created": {
      const existing = state.threads.find((thread) => thread.id === event.payload.threadId);
      const nextThread = mapProjectThread(event);
      const threads = existing
        ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
        : [...state.threads, nextThread];
      if (nextThread.purpose === "side-chat") {
        return { ...state, threads };
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
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
      };
    }

    case "thread.deleted": {
      const threads = state.threads.filter((thread) => thread.id !== event.payload.threadId);
      if (threads.length === state.threads.length) {
        return state;
      }
      const deletedThread = state.threads.find((thread) => thread.id === event.payload.threadId);
      const sidebarThreadsById = { ...state.sidebarThreadsById };
      delete sidebarThreadsById[event.payload.threadId];
      const threadIdsByProjectId = deletedThread
        ? removeThreadIdByProjectId(
            state.threadIdsByProjectId,
            deletedThread.projectId,
            deletedThread.id,
          )
        : state.threadIdsByProjectId;
      return {
        ...state,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
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
