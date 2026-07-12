import type {
  ApprovalRequestId,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationThreadActivity,
  UserInputQuestion,
} from "@bigbud/contracts";
import { isBuiltInChatsProject } from "@bigbud/contracts";

import {
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "~/components/sidebar/Sidebar.sort.logic";

/** Matches desktop `THREAD_PREVIEW_LIMIT` / `RECENT_CHAT_INITIAL_VISIBLE_COUNT`. */
export const MOBILE_THREAD_PREVIEW_LIMIT = 4;

export interface MobilePendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: "command" | "file-read" | "file-change" | "tool";
  readonly createdAt: string;
}

export interface MobilePendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

function compareActivitiesByOrder(
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
  return left.createdAt.localeCompare(right.createdAt);
}

function requestKindFromRequestType(
  requestType: unknown,
): MobilePendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "dynamic_tool_call":
      return "tool";
    default:
      return null;
  }
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<MobilePendingApproval> {
  const openByRequestId = new Map<ApprovalRequestId, MobilePendingApproval>();

  for (const activity of [...activities].toSorted(compareActivitiesByOrder)) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      typeof payload?.requestId === "string" ? (payload.requestId as ApprovalRequestId) : null;
    if (activity.kind === "approval.requested" && requestId) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind:
          (payload?.requestKind as MobilePendingApproval["requestKind"] | undefined) ??
          requestKindFromRequestType(payload?.requestType) ??
          "tool",
        createdAt: activity.createdAt,
      });
    }
    if (
      requestId &&
      (activity.kind === "approval.resolved" ||
        activity.kind === "provider.approval.respond.failed")
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<MobilePendingUserInput> {
  const openByRequestId = new Map<ApprovalRequestId, MobilePendingUserInput>();

  for (const activity of [...activities].toSorted(compareActivitiesByOrder)) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      typeof payload?.requestId === "string" ? (payload.requestId as ApprovalRequestId) : null;

    if (
      activity.kind === "user-input.requested" &&
      requestId &&
      Array.isArray(payload?.questions)
    ) {
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions: payload.questions as ReadonlyArray<UserInputQuestion>,
      });
    }
    if (
      requestId &&
      (activity.kind === "user-input.resolved" ||
        activity.kind === "provider.user-input.respond.failed")
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function getThreadProjectTitle(
  snapshot: OrchestrationReadModel,
  thread: OrchestrationThread,
): string {
  return (
    snapshot.projects.find((project) => project.id === thread.projectId)?.title ?? "Unknown project"
  );
}

function getLatestUserMessageAt(messages: ReadonlyArray<OrchestrationMessage>): string | null {
  let latestUserMessageAt: string | null = null;

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
      latestUserMessageAt = message.createdAt;
    }
  }

  return latestUserMessageAt;
}

function toSidebarThreadSortInput(thread: OrchestrationThread) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    latestUserMessageAt: getLatestUserMessageAt(thread.messages),
    messages: thread.messages.map((message) => ({
      createdAt: message.createdAt,
      role: message.role,
    })),
  };
}

function activeThreads(snapshot: OrchestrationReadModel): ReadonlyArray<OrchestrationThread> {
  return snapshot.threads.filter(
    (thread) => thread.archivedAt === null && thread.purpose !== "side-chat",
  );
}

export function sortThreadsForMobile(
  threads: ReadonlyArray<OrchestrationThread>,
): ReadonlyArray<OrchestrationThread> {
  const sortableThreads = threads.map((thread) => toSidebarThreadSortInput(thread));
  const sortedIds = sortThreadsForSidebar(sortableThreads, "updated_at").map((thread) => thread.id);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));
  return sortedIds
    .map((threadId) => threadsById.get(threadId))
    .filter((thread): thread is OrchestrationThread => thread !== undefined);
}

export function chatThreadsForMobile(
  snapshot: OrchestrationReadModel,
): ReadonlyArray<OrchestrationThread> {
  return sortThreadsForMobile(
    activeThreads(snapshot).filter((thread) => isBuiltInChatsProject(thread.projectId)),
  );
}

export function sortProjectsForMobile(
  snapshot: OrchestrationReadModel,
): ReadonlyArray<OrchestrationProject> {
  const projects = snapshot.projects.filter((project) => !isBuiltInChatsProject(project.id));
  const threads = activeThreads(snapshot).map((thread) => toSidebarThreadSortInput(thread));
  const sortedProjects = sortProjectsForSidebar(
    projects.map((project) => ({
      id: project.id,
      name: project.title,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    threads,
    "updated_at",
  );
  const projectsById = new Map(projects.map((project) => [project.id, project] as const));
  return sortedProjects
    .map((project) => projectsById.get(project.id))
    .filter((project): project is OrchestrationProject => project !== undefined);
}

export function sortThreads(snapshot: OrchestrationReadModel): ReadonlyArray<OrchestrationThread> {
  return sortThreadsForMobile(activeThreads(snapshot));
}

export function sortProjects(snapshot: OrchestrationReadModel) {
  return sortProjectsForMobile(snapshot);
}

export function threadsForProject(
  snapshot: OrchestrationReadModel,
  projectId: OrchestrationThread["projectId"],
): ReadonlyArray<OrchestrationThread> {
  return sortThreadsForMobile(
    activeThreads(snapshot).filter((thread) => thread.projectId === projectId),
  );
}

export function resolveThreadWorkspaceRoot(
  snapshot: OrchestrationReadModel,
  thread: OrchestrationThread,
): string | undefined {
  const project = snapshot.projects.find((candidate) => candidate.id === thread.projectId);
  return thread.worktreePath ?? project?.workspaceRoot ?? undefined;
}
