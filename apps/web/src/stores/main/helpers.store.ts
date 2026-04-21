import { type ProjectId, ThreadId } from "@bigbud/contracts";
import { type OrchestrationReadModel } from "@bigbud/contracts";
import {
  buildSidebarThreadSummary,
  mapProject,
  mapThread,
  sidebarThreadSummariesEqual,
} from "./mappers.store";
import { type AppState } from "./main.store";
import {
  type ChatMessage,
  type Project,
  type SidebarThreadSummary,
  type Thread,
} from "../../models/types";

// ── Constants ────────────────────────────────────────────────────────

export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_CHECKPOINTS = 500;
export const MAX_THREAD_PROPOSED_PLANS = 200;
export const MAX_THREAD_ACTIVITIES = 500;
export const EMPTY_THREAD_IDS: ThreadId[] = [];

// ── Index helpers ─────────────────────────────────────────────────────

export function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

export function updateProject(
  projects: Project[],
  projectId: Project["id"],
  updater: (project: Project) => Project,
): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const updated = updater(project);
    if (updated !== project) {
      changed = true;
    }
    return updated;
  });
  return changed ? next : projects;
}

export function appendThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: [...existingThreadIds, threadId],
  };
}

export function removeThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (!existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  const nextThreadIds = existingThreadIds.filter(
    (existingThreadId) => existingThreadId !== threadId,
  );
  if (nextThreadIds.length === existingThreadIds.length) {
    return threadIdsByProjectId;
  }
  if (nextThreadIds.length === 0) {
    const nextThreadIdsByProjectId = { ...threadIdsByProjectId };
    delete nextThreadIdsByProjectId[projectId];
    return nextThreadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: nextThreadIds,
  };
}

export function buildThreadIdsByProjectId(
  threads: ReadonlyArray<Thread>,
): Record<string, ThreadId[]> {
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const thread of threads) {
    const existingThreadIds = threadIdsByProjectId[thread.projectId] ?? EMPTY_THREAD_IDS;
    threadIdsByProjectId[thread.projectId] = [...existingThreadIds, thread.id];
  }
  return threadIdsByProjectId;
}

export function buildSidebarThreadsById(
  threads: ReadonlyArray<Thread>,
): Record<string, SidebarThreadSummary> {
  return Object.fromEntries(
    threads.map((thread) => [thread.id, buildSidebarThreadSummary(thread)]),
  );
}

// ── Turn / checkpoint helpers ─────────────────────────────────────────

export function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

export function compareActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

export function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
  turnId: Thread["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): Thread["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...turnDiffSummaries];
}

// ── Revert helpers ────────────────────────────────────────────────────

export function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

export function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

export function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

// ── Thread state updater ──────────────────────────────────────────────

export function updateThreadState(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
): AppState {
  let updatedThread: Thread | null = null;
  const threads = updateThread(state.threads, threadId, (thread) => {
    const nextThread = updater(thread);
    if (nextThread !== thread) {
      updatedThread = nextThread;
    }
    return nextThread;
  });
  if (threads === state.threads || updatedThread === null) {
    return state;
  }

  const nextSummary = buildSidebarThreadSummary(updatedThread);
  const previousSummary = state.sidebarThreadsById[threadId];
  const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
    ? state.sidebarThreadsById
    : {
        ...state.sidebarThreadsById,
        [threadId]: nextSummary,
      };

  if (sidebarThreadsById === state.sidebarThreadsById) {
    return {
      ...state,
      threads,
    };
  }

  return {
    ...state,
    threads,
    sidebarThreadsById,
  };
}

// ── Thread revert state updater ───────────────────────────────────────

/** Applies the `thread.reverted` event payload to a thread, pruning messages, plans, activities,
 *  and checkpoints to the retained turn set. */
export function applyThreadReverted(
  thread: Thread,
  payload: { turnCount: number; occurredAt: string },
): Thread {
  const turnDiffSummaries = thread.turnDiffSummaries
    .filter(
      (entry) =>
        entry.checkpointTurnCount !== undefined && entry.checkpointTurnCount <= payload.turnCount,
    )
    .toSorted(
      (left, right) =>
        (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
        (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(-MAX_THREAD_CHECKPOINTS);
  const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
  const messages = retainThreadMessagesAfterRevert(
    thread.messages,
    retainedTurnIds,
    payload.turnCount,
  ).slice(-MAX_THREAD_MESSAGES);
  const proposedPlans = retainThreadProposedPlansAfterRevert(
    thread.proposedPlans,
    retainedTurnIds,
  ).slice(-MAX_THREAD_PROPOSED_PLANS);
  const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
  const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;
  return {
    ...thread,
    turnDiffSummaries,
    messages,
    proposedPlans,
    activities,
    pendingSourceProposedPlan: undefined,
    latestTurn:
      latestCheckpoint === null
        ? null
        : {
            turnId: latestCheckpoint.turnId,
            state: checkpointStatusToLatestTurnState(
              (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
            ),
            requestedAt: latestCheckpoint.completedAt,
            startedAt: latestCheckpoint.completedAt,
            completedAt: latestCheckpoint.completedAt,
            assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
          },
    updatedAt: payload.occurredAt,
  };
}

// ── Pure state sync ───────────────────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const threads = readModel.threads.filter((thread) => thread.deletedAt === null).map(mapThread);
  const sidebarThreadsById = buildSidebarThreadsById(threads);
  const threadIdsByProjectId = buildThreadIdsByProjectId(threads);
  return {
    ...state,
    projects,
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    bootstrapComplete: true,
  };
}
