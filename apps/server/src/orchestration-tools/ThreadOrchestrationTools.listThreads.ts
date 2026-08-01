import type { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type {
  OrchestrationThread,
  OrchestrationThreadPurpose,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  resolveThreadWorkflowStatus,
  type ThreadWorkflowStatusSnapshot,
} from "../orchestration/ThreadWorkflowStatus.logic.ts";

export const LIST_THREADS_DEFAULT_LIMIT = 50;
export const LIST_THREADS_MAX_LIMIT = 200;

export const LIST_THREADS_STATUS_FILTERS = ["active", "archived", "all"] as const;
export type ListThreadsStatusFilter = (typeof LIST_THREADS_STATUS_FILTERS)[number];

export interface ListThreadsRow {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly workflowStatus: ThreadWorkflowStatusSnapshot["workflowStatus"];
  readonly isAgentActive: boolean;
  readonly isWorkflowComplete: boolean;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly deleting: boolean;
  readonly purpose: OrchestrationThreadPurpose;
  readonly parentThreadId: ThreadId | null;
  readonly latestTurnState: ThreadWorkflowStatusSnapshot["latestTurnState"];
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAssistantExcerpt?: string | null;
}

/**
 * Clamps a caller-supplied limit rather than rejecting it, so a model that
 * overshoots the cap still receives a usable page alongside `hasMore`.
 */
export function normalizeListThreadsLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return LIST_THREADS_DEFAULT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(limit), 1), LIST_THREADS_MAX_LIMIT);
}

/**
 * Coerces an untrusted status filter to a supported value. Bridges that hand
 * model arguments straight to the dispatcher have no schema validation in front
 * of them, so an unrecognized filter degrades to the default instead of being
 * silently treated as an unknown branch.
 */
export function normalizeListThreadsStatus(value: unknown): ListThreadsStatusFilter {
  return typeof value === "string" &&
    LIST_THREADS_STATUS_FILTERS.includes(value as ListThreadsStatusFilter)
    ? (value as ListThreadsStatusFilter)
    : "active";
}

function matchesStatusFilter(
  thread: OrchestrationThread,
  status: ListThreadsStatusFilter,
): boolean {
  if (status === "all") {
    return true;
  }
  const archived = thread.archivedAt !== null;
  return status === "archived" ? archived : !archived;
}

function toRow(input: {
  readonly thread: OrchestrationThread;
  readonly includeExcerpt: boolean;
}): ListThreadsRow {
  const status = resolveThreadWorkflowStatus(input.thread);
  return {
    threadId: status.threadId,
    title: status.title,
    workflowStatus: status.workflowStatus,
    isAgentActive: status.isAgentActive,
    isWorkflowComplete: status.isWorkflowComplete,
    archived: input.thread.archivedAt !== null,
    pinned: (input.thread.pinnedAt ?? null) !== null,
    deleting: Boolean(input.thread.deletingAt),
    purpose: input.thread.purpose ?? "standard",
    parentThreadId: input.thread.parentThread?.threadId ?? null,
    latestTurnState: status.latestTurnState,
    hasPendingApprovals: status.hasPendingApprovals,
    hasPendingUserInput: status.hasPendingUserInput,
    messageCount: input.thread.messages.length,
    createdAt: input.thread.createdAt,
    updatedAt: input.thread.updatedAt,
    ...(input.includeExcerpt ? { lastAssistantExcerpt: status.lastAssistantExcerpt } : {}),
  };
}

export const listThreadsViaOrchestration = Effect.fn("listThreadsViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly callerThreadId: ThreadId;
    readonly projectId?: ProjectId | undefined;
    readonly status?: ListThreadsStatusFilter | undefined;
    readonly limit?: number | undefined;
    readonly includeExcerpt?: boolean | undefined;
  }) {
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const callerThread = readModel.threads.find((thread) => thread.id === input.callerThreadId);
    if (!callerThread || callerThread.deletedAt !== null) {
      return yield* Effect.fail(new Error("Caller thread could not be resolved."));
    }

    const targetProjectId = input.projectId ?? callerThread.projectId;
    const project = readModel.projects.find((candidate) => candidate.id === targetProjectId);
    if (!project || project.deletedAt !== null) {
      return yield* Effect.fail(new Error(`Project '${targetProjectId}' was not found.`));
    }

    const status = input.status ?? "active";
    const limit = normalizeListThreadsLimit(input.limit);
    const includeExcerpt = input.includeExcerpt === true;

    const matching = readModel.threads.filter(
      (thread) =>
        thread.projectId === targetProjectId &&
        thread.deletedAt === null &&
        matchesStatusFilter(thread, status),
    );
    // Sort and slice before deriving workflow status: that derivation scans a
    // thread's activities and messages, so it must only run for the page returned.
    const page = matching
      .toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      )
      .slice(0, limit);

    return {
      projectId: targetProjectId,
      projectTitle: project.title,
      status,
      limit,
      totalCount: matching.length,
      returnedCount: page.length,
      hasMore: matching.length > page.length,
      threads: page.map((thread) => toRow({ thread, includeExcerpt })),
    } as const;
  },
);
