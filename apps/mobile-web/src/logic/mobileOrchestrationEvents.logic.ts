import {
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@bigbud/contracts";

import { isStaleRunningSessionUpdate } from "~/stores/main/events.store.threads.runtime.logic";
import {
  buildThreadMessageLatestTurn,
  compareActivities,
  mapMessageFromEvent,
  mapProjectFromCreatedEvent,
  mapThreadFromCreatedEvent,
  MAX_THREAD_ACTIVITIES,
  updateThreadInSnapshot,
  upsertThreadMessage,
} from "./mobileOrchestrationEvents.helpers";

export function applyOrchestrationEventToThread(
  thread: OrchestrationThread,
  event: OrchestrationEvent,
): OrchestrationThread | null {
  switch (event.type) {
    case "thread.message-sent": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      const message = mapMessageFromEvent(event);
      return {
        ...thread,
        messages: upsertThreadMessage(thread, message, event),
        latestTurn: buildThreadMessageLatestTurn(thread, event),
        updatedAt: event.occurredAt,
      };
    }

    case "thread.session-set": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      const incomingSession = event.payload.session;
      const incomingActiveTurnId = incomingSession.activeTurnId ?? null;
      const hasNonStreamingAssistantMessageForTurn =
        incomingActiveTurnId !== null &&
        thread.messages.some(
          (message) =>
            message.turnId === incomingActiveTurnId &&
            message.role === "assistant" &&
            message.streaming === false,
        );
      const isStaleRunningSession = isStaleRunningSessionUpdate({
        incomingStatus: incomingSession.status,
        incomingActiveTurnId,
        incomingReason: incomingSession.reason,
        latestTurn: thread.latestTurn,
        hasNonStreamingAssistantMessageForTurn,
      });
      const normalizedSession = isStaleRunningSession
        ? { ...incomingSession, status: "ready" as const, activeTurnId: null, reason: null }
        : incomingSession;
      return {
        ...thread,
        session: normalizedSession,
        latestTurn:
          normalizedSession.status === "running" && incomingActiveTurnId !== null
            ? {
                turnId: incomingActiveTurnId,
                state:
                  thread.latestTurn?.turnId === incomingActiveTurnId &&
                  thread.latestTurn.completedAt
                    ? thread.latestTurn.state
                    : "running",
                requestedAt:
                  thread.latestTurn?.turnId === incomingActiveTurnId
                    ? thread.latestTurn.requestedAt
                    : normalizedSession.updatedAt,
                startedAt:
                  thread.latestTurn?.turnId === incomingActiveTurnId
                    ? (thread.latestTurn.startedAt ?? normalizedSession.updatedAt)
                    : normalizedSession.updatedAt,
                completedAt:
                  thread.latestTurn?.turnId === incomingActiveTurnId
                    ? (thread.latestTurn.completedAt ?? null)
                    : null,
                assistantMessageId:
                  thread.latestTurn?.turnId === incomingActiveTurnId
                    ? (thread.latestTurn.assistantMessageId ?? null)
                    : null,
              }
            : thread.latestTurn,
        updatedAt: event.occurredAt,
      };
    }

    case "thread.session-stop-requested": {
      if (event.payload.threadId !== thread.id || thread.session === null) {
        return null;
      }
      return {
        ...thread,
        session: {
          ...thread.session,
          status: "stopped",
          activeTurnId: null,
          updatedAt: event.payload.createdAt,
        },
        updatedAt: event.occurredAt,
      };
    }

    case "thread.activity-appended": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      const activities = [
        ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
        { ...event.payload.activity },
      ]
        .toSorted(compareActivities)
        .slice(-MAX_THREAD_ACTIVITIES);
      return {
        ...thread,
        activities,
        updatedAt: event.occurredAt,
      };
    }

    case "thread.meta-updated": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.providerRuntimeExecutionTargetId !== undefined
          ? { providerRuntimeExecutionTargetId: event.payload.providerRuntimeExecutionTargetId }
          : {}),
        ...(event.payload.workspaceExecutionTargetId !== undefined
          ? { workspaceExecutionTargetId: event.payload.workspaceExecutionTargetId }
          : {}),
        ...(event.payload.executionTargetId !== undefined
          ? { executionTargetId: event.payload.executionTargetId }
          : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        updatedAt: event.payload.updatedAt,
      };
    }

    case "thread.runtime-mode-set": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      };
    }

    case "thread.interaction-mode-set": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      };
    }

    case "thread.archived": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: event.payload.updatedAt,
      };
    }

    case "thread.unarchived": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      };
    }

    case "thread.pinned": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        pinnedAt: event.payload.pinnedAt,
        updatedAt: event.payload.updatedAt,
      };
    }

    case "thread.unpinned": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        pinnedAt: null,
        updatedAt: event.payload.updatedAt,
      };
    }

    case "thread.deletion-requested": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        deletingAt: event.payload.deletingAt,
        updatedAt: event.payload.deletingAt,
      };
    }

    case "thread.deletion-failed": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        deletingAt: null,
        updatedAt: event.payload.updatedAt,
      };
    }

    case "thread.turn-start-requested": {
      if (event.payload.threadId !== thread.id) {
        return null;
      }
      return {
        ...thread,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.occurredAt,
      };
    }

    case "thread.turn-interrupt-requested": {
      if (event.payload.threadId !== thread.id || event.payload.turnId === undefined) {
        return null;
      }
      if (thread.latestTurn === null || thread.latestTurn.turnId !== event.payload.turnId) {
        return null;
      }
      return {
        ...thread,
        latestTurn: {
          ...thread.latestTurn,
          state: "interrupted",
          completedAt: thread.latestTurn.completedAt ?? event.payload.createdAt,
        },
        updatedAt: event.occurredAt,
      };
    }

    default:
      return null;
  }
}

export function applyOrchestrationEventToSnapshot(
  snapshot: OrchestrationReadModel,
  event: OrchestrationEvent,
): { snapshot: OrchestrationReadModel; changed: boolean } {
  const threadId = "threadId" in event.payload ? event.payload.threadId : null;
  if (threadId !== null) {
    const existingThread = snapshot.threads.find((thread) => thread.id === threadId);
    if (existingThread) {
      const nextThread = applyOrchestrationEventToThread(existingThread, event);
      if (nextThread !== null) {
        return {
          changed: true,
          snapshot: updateThreadInSnapshot(snapshot, threadId, () => nextThread),
        };
      }
    }
  }

  switch (event.type) {
    case "thread.created": {
      const nextThread = mapThreadFromCreatedEvent(event);
      const existingIndex = snapshot.threads.findIndex((thread) => thread.id === nextThread.id);
      const threads =
        existingIndex >= 0
          ? snapshot.threads.map((thread, index) => (index === existingIndex ? nextThread : thread))
          : [...snapshot.threads, nextThread];
      return {
        changed: true,
        snapshot: { ...snapshot, threads, updatedAt: event.occurredAt },
      };
    }

    case "thread.deleted": {
      const threads = snapshot.threads.filter((thread) => thread.id !== event.payload.threadId);
      if (threads.length === snapshot.threads.length) {
        return { changed: false, snapshot };
      }
      return {
        changed: true,
        snapshot: { ...snapshot, threads, updatedAt: event.occurredAt },
      };
    }

    case "project.created": {
      const nextProject = mapProjectFromCreatedEvent(event);
      const existingIndex = snapshot.projects.findIndex((project) => project.id === nextProject.id);
      const projects =
        existingIndex >= 0
          ? snapshot.projects.map((project, index) =>
              index === existingIndex ? nextProject : project,
            )
          : [...snapshot.projects, nextProject];
      return {
        changed: true,
        snapshot: { ...snapshot, projects, updatedAt: event.occurredAt },
      };
    }

    case "project.meta-updated": {
      const projects = snapshot.projects.map((project) =>
        project.id !== event.payload.projectId
          ? project
          : {
              ...project,
              ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
              ...(event.payload.providerRuntimeExecutionTargetId !== undefined
                ? {
                    providerRuntimeExecutionTargetId:
                      event.payload.providerRuntimeExecutionTargetId,
                  }
                : {}),
              ...(event.payload.workspaceExecutionTargetId !== undefined
                ? { workspaceExecutionTargetId: event.payload.workspaceExecutionTargetId }
                : {}),
              ...(event.payload.executionTargetId !== undefined
                ? { executionTargetId: event.payload.executionTargetId }
                : {}),
              ...(event.payload.workspaceRoot !== undefined
                ? { workspaceRoot: event.payload.workspaceRoot }
                : {}),
              ...(event.payload.defaultModelSelection !== undefined
                ? { defaultModelSelection: event.payload.defaultModelSelection }
                : {}),
              ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
              updatedAt: event.payload.updatedAt,
            },
      );
      return {
        changed: true,
        snapshot: { ...snapshot, projects, updatedAt: event.occurredAt },
      };
    }

    case "project.deleted": {
      const projects = snapshot.projects.filter(
        (project) => project.id !== event.payload.projectId,
      );
      if (projects.length === snapshot.projects.length) {
        return { changed: false, snapshot };
      }
      return {
        changed: true,
        snapshot: { ...snapshot, projects, updatedAt: event.occurredAt },
      };
    }

    default:
      return { changed: false, snapshot };
  }
}
