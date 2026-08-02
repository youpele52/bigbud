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

const MAX_THREAD_MESSAGES = 500;

export const MAX_THREAD_ACTIVITIES = 500;

export function compareActivities(
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
  if (createdAtComparison !== 0) return createdAtComparison;
  return left.id.localeCompare(right.id);
}

export function updateThreadInSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  updater: (thread: OrchestrationThread) => OrchestrationThread,
): OrchestrationReadModel {
  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.id !== threadId) return thread;
    changed = true;
    return updater(thread);
  });
  return changed ? { ...snapshot, threads, updatedAt: new Date().toISOString() } : snapshot;
}

export function upsertThreadMessage(
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

export function buildThreadMessageLatestTurn(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): OrchestrationLatestTurn | null {
  if (event.payload.role !== "assistant" || event.payload.turnId === null) return thread.latestTurn;
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

export function mapMessageFromEvent(
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

export function mapThreadFromCreatedEvent(
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
    pinnedAt: null,
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

export function mapProjectFromCreatedEvent(
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
