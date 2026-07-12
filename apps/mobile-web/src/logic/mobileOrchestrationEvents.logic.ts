import {
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@bigbud/contracts";

import { isStaleRunningSessionUpdate } from "~/stores/main/events.store.threads.runtime.logic";

const MAX_THREAD_MESSAGES = 500;
const MAX_THREAD_ACTIVITIES = 500;

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    left.sequence !== right.sequence
  ) {
    return left.sequence - right.sequence;
  }
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }
  return left.id.localeCompare(right.id);
}

function updateThreadInSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  updater: (thread: OrchestrationThread) => OrchestrationThread,
): OrchestrationReadModel {
  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.id !== threadId) {
      return thread;
    }
    changed = true;
    return updater(thread);
  });
  return changed ? { ...snapshot, threads, updatedAt: new Date().toISOString() } : snapshot;
}

function upsertThreadMessage(
  thread: OrchestrationThread,
  message: OrchestrationMessage,
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): OrchestrationMessage[] {
  const existingMessage = thread.messages.find((entry) => entry.id === message.id);
  const messages = existingMessage
    ? thread.messages.map((entry) =>
        entry.id !== message.id
          ? entry
          : {
              ...entry,
              text:
                event.payload.replace === true
                  ? message.text
                  : message.streaming
                    ? `${entry.text}${message.text}`
                    : message.text.length > 0
                      ? message.text
                      : entry.text,
              streaming: message.streaming,
              turnId: message.turnId,
              updatedAt: message.updatedAt,
              ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
              ...(message.replyTo !== undefined
                ? { replyTo: message.replyTo }
                : entry.replyTo !== undefined
                  ? { replyTo: entry.replyTo }
                  : {}),
            },
      )
    : [...thread.messages, message];
  return messages.slice(-MAX_THREAD_MESSAGES);
}

function buildThreadMessageLatestTurn(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): OrchestrationLatestTurn | null {
  if (event.payload.role !== "assistant" || event.payload.turnId === null) {
    return thread.latestTurn;
  }
  if (thread.latestTurn !== null && thread.latestTurn.turnId !== event.payload.turnId) {
    return thread.latestTurn;
  }
  const previous = thread.latestTurn;
  return {
    turnId: event.payload.turnId,
    state: event.payload.streaming
      ? "running"
      : previous?.state === "interrupted"
        ? "interrupted"
        : previous?.state === "error"
          ? "error"
          : "completed",
    requestedAt:
      previous?.turnId === event.payload.turnId ? previous.requestedAt : event.payload.createdAt,
    startedAt:
      previous?.turnId === event.payload.turnId
        ? (previous.startedAt ?? event.payload.createdAt)
        : event.payload.createdAt,
    completedAt: event.payload.streaming
      ? previous?.turnId === event.payload.turnId
        ? (previous.completedAt ?? null)
        : null
      : event.payload.updatedAt,
    assistantMessageId: event.payload.messageId,
    ...(previous?.sourceProposedPlan !== undefined
      ? { sourceProposedPlan: previous.sourceProposedPlan }
      : {}),
  };
}

function mapMessageFromEvent(
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): OrchestrationMessage {
  return {
    id: event.payload.messageId,
    role: event.payload.role,
    text: event.payload.text,
    ...(event.payload.attachments !== undefined ? { attachments: event.payload.attachments } : {}),
    ...(event.payload.replyTo !== undefined ? { replyTo: event.payload.replyTo } : {}),
    turnId: event.payload.turnId,
    streaming: event.payload.streaming,
    createdAt: event.payload.createdAt,
    updatedAt: event.payload.updatedAt,
  };
}

function mapThreadFromCreatedEvent(
  event: Extract<OrchestrationEvent, { type: "thread.created" }>,
): OrchestrationThread {
  return {
    id: event.payload.threadId,
    projectId: event.payload.projectId,
    title: event.payload.title,
    purpose: event.payload.purpose ?? "standard",
    elevatorSummary: event.payload.title,
    elevatorSummaryMessageCount: 0,
    ...(event.payload.providerRuntimeExecutionTargetId !== undefined
      ? { providerRuntimeExecutionTargetId: event.payload.providerRuntimeExecutionTargetId }
      : {}),
    ...(event.payload.workspaceExecutionTargetId !== undefined
      ? { workspaceExecutionTargetId: event.payload.workspaceExecutionTargetId }
      : {}),
    ...(event.payload.executionTargetId !== undefined
      ? { executionTargetId: event.payload.executionTargetId }
      : {}),
    modelSelection: event.payload.modelSelection,
    runtimeMode: event.payload.runtimeMode,
    interactionMode: event.payload.interactionMode,
    branch: event.payload.branch,
    worktreePath: event.payload.worktreePath,
    ...(event.payload.parentThread !== undefined
      ? { parentThread: event.payload.parentThread }
      : {}),
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
  };
}

function mapProjectFromCreatedEvent(
  event: Extract<OrchestrationEvent, { type: "project.created" }>,
): OrchestrationProject {
  return {
    id: event.payload.projectId,
    title: event.payload.title,
    ...(event.payload.providerRuntimeExecutionTargetId !== undefined
      ? { providerRuntimeExecutionTargetId: event.payload.providerRuntimeExecutionTargetId }
      : {}),
    ...(event.payload.workspaceExecutionTargetId !== undefined
      ? { workspaceExecutionTargetId: event.payload.workspaceExecutionTargetId }
      : {}),
    ...(event.payload.executionTargetId !== undefined
      ? { executionTargetId: event.payload.executionTargetId }
      : {}),
    workspaceRoot: event.payload.workspaceRoot,
    defaultModelSelection: event.payload.defaultModelSelection,
    scripts: event.payload.scripts,
    createdAt: event.payload.createdAt,
    updatedAt: event.payload.updatedAt,
    deletingAt: null,
    deletedAt: null,
  };
}

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
