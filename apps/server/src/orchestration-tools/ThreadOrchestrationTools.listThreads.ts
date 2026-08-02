import type { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationThreadPurpose } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect } from "effect";

import type { ProjectionCatalogQueryShape } from "../orchestration/Services/ProjectionCatalogQuery.ts";
import type { ThreadWorkflowStatusSnapshot } from "../orchestration/ThreadWorkflowStatus.logic.ts";

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

export const listThreadsViaOrchestration = Effect.fn("listThreadsViaOrchestration")(
  function* (input: {
    readonly projectionCatalogQuery: ProjectionCatalogQueryShape;
    readonly callerThreadId: ThreadId;
    readonly projectId?: ProjectId | undefined;
    readonly status?: ListThreadsStatusFilter | undefined;
    readonly limit?: number | undefined;
    readonly includeExcerpt?: boolean | undefined;
  }) {
    const status = input.status ?? "active";
    const limit = normalizeListThreadsLimit(input.limit);
    const listing = yield* input.projectionCatalogQuery.listThreads({
      callerThreadId: input.callerThreadId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      status,
      limit,
      includeExcerpt: input.includeExcerpt === true,
    });
    if (!listing.callerResolved) {
      return yield* Effect.fail(new Error("Caller thread could not be resolved."));
    }
    if (!listing.projectId || !listing.projectTitle) {
      return yield* Effect.fail(
        new Error(`Project '${input.projectId ?? "caller project"}' was not found.`),
      );
    }

    return {
      projectId: listing.projectId,
      projectTitle: listing.projectTitle,
      status,
      limit,
      totalCount: listing.totalCount,
      returnedCount: listing.threads.length,
      hasMore: listing.totalCount > listing.threads.length,
      threads: listing.threads,
    } as const;
  },
);
