import { Schema } from "effect";

import {
  ExecutionTargetId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../core/baseSchemas";
import {
  HistoricalModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.provider";
import {
  ElevatorSummary,
  OrchestrationLatestTurnState,
  OrchestrationSessionStatus,
  OrchestrationThreadPurpose,
} from "./orchestration.thread";
import { ThreadOrganizationField } from "./orchestration.organization";
import { SIDEBAR_THREAD_SORT_ORDERS } from "../constants/settings.constant";

export const STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT = 1;
export const STARTUP_PROJECT_CATALOG_MAX_LIMIT = 20;
/** Sidebar project pages match the 4-row preview; "Show 4 more" fetches the next page. */
export const PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT = 4;
export const PROJECT_THREAD_SUMMARY_MAX_LIMIT = 50;
export const SIDEBAR_THREAD_CATALOG_RECENT_LIMIT = 5;
export const SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS = SIDEBAR_THREAD_CATALOG_RECENT_LIMIT * 2;

export const ProjectSummary = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  providerRuntimeExecutionTargetId: ExecutionTargetId,
  workspaceExecutionTargetId: ExecutionTargetId,
  executionTargetId: ExecutionTargetId,
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  workspaceKind: Schema.optional(Schema.Literals(["managed", "external"])),
  previousWorkspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  lastUsedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletingAt: Schema.NullOr(IsoDateTime),
  threadCount: NonNegativeInt,
  exceptionalThreadCount: NonNegativeInt,
  hasExceptionalThreads: Schema.Boolean,
});
export type ProjectSummary = typeof ProjectSummary.Type;

export const ThreadSummary = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  purpose: OrchestrationThreadPurpose,
  elevatorSummary: Schema.NullOr(ElevatorSummary),
  modelSelection: HistoricalModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providerRuntimeExecutionTargetId: ExecutionTargetId,
  workspaceExecutionTargetId: ExecutionTargetId,
  executionTargetId: ExecutionTargetId,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  organization: ThreadOrganizationField,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  activeTurnId: Schema.NullOr(TurnId),
  /** Owned native descendants may outlive the parent turn (OrchestrationSession.retainedFamily). */
  retainedFamily: Schema.optional(Schema.Boolean),
  latestTurnState: Schema.NullOr(OrchestrationLatestTurnState),
  isWatching: Schema.Boolean,
  isWatched: Schema.Boolean,
  isDelegated: Schema.Boolean,
  isAwaitingApproval: Schema.Boolean,
  isAwaitingUserInput: Schema.optional(Schema.Boolean),
});
export type ThreadSummary = typeof ThreadSummary.Type;

export const ProjectThreadCount = Schema.Struct({
  projectId: ProjectId,
  threadCount: NonNegativeInt,
});
export type ProjectThreadCount = typeof ProjectThreadCount.Type;

export const ProjectCatalogCursor = Schema.Struct({
  lastUsedAt: IsoDateTime,
  projectId: ProjectId,
});
export type ProjectCatalogCursor = typeof ProjectCatalogCursor.Type;

export const ProjectCatalogScope = Schema.Literals(["local", "remote"]);
export type ProjectCatalogScope = typeof ProjectCatalogScope.Type;

/**
 * The displayed sidebar order: `updated_at` is the latest user message (falling back to creation),
 * `created_at` is creation time. Both page by `(sortKey DESC, threadId DESC)`.
 */
export const ThreadSummarySortOrder = Schema.Literals(SIDEBAR_THREAD_SORT_ORDERS);
export type ThreadSummarySortOrder = typeof ThreadSummarySortOrder.Type;

export const ThreadSummaryCursor = Schema.Struct({
  updatedAt: IsoDateTime,
  threadId: ThreadId,
  /** Sort key of the last row for display-ordered pages; absent on legacy `updated_at` pages. */
  sortKey: Schema.optional(IsoDateTime),
  sortOrder: Schema.optional(ThreadSummarySortOrder),
});
export type ThreadSummaryCursor = typeof ThreadSummaryCursor.Type;

export const GetStartupProjectCatalogInput = Schema.Struct({
  scope: ProjectCatalogScope,
  limit: Schema.optional(PositiveInt),
  query: Schema.optional(TrimmedNonEmptyString),
  priorityProjectId: Schema.optional(ProjectId),
  cursor: Schema.optional(ProjectCatalogCursor),
});
export type GetStartupProjectCatalogInput = typeof GetStartupProjectCatalogInput.Type;

export const GetStartupProjectCatalogResult = Schema.Struct({
  projectionSequence: NonNegativeInt,
  projects: Schema.Array(ProjectSummary),
  remainingCount: NonNegativeInt,
  nextCursor: Schema.optional(ProjectCatalogCursor),
});
export type GetStartupProjectCatalogResult = typeof GetStartupProjectCatalogResult.Type;

export const GetProjectThreadSummariesInput = Schema.Struct({
  projectId: ProjectId,
  limit: Schema.optional(PositiveInt),
  priorityThreadId: Schema.optional(ThreadId),
  cursor: Schema.optional(ThreadSummaryCursor),
  /** Display order. Absent keeps the legacy `updated_at`-column order for older callers. */
  sortOrder: Schema.optional(ThreadSummarySortOrder),
});
export type GetProjectThreadSummariesInput = typeof GetProjectThreadSummariesInput.Type;

export const GetProjectThreadSummariesResult = Schema.Struct({
  projectionSequence: NonNegativeInt,
  projectId: ProjectId,
  threads: Schema.Array(ThreadSummary),
  nextCursor: Schema.optional(ThreadSummaryCursor),
});
export type GetProjectThreadSummariesResult = typeof GetProjectThreadSummariesResult.Type;

export const GetSidebarThreadCatalogInput = Schema.Struct({});
export type GetSidebarThreadCatalogInput = typeof GetSidebarThreadCatalogInput.Type;

export const GetSidebarThreadCatalogResult = Schema.Struct({
  projectionSequence: NonNegativeInt,
  threads: Schema.Array(ThreadSummary),
  recentThreadIds: Schema.Array(ThreadId),
  pinnedThreadIds: Schema.Array(ThreadId),
  projectThreadCounts: Schema.optional(Schema.Array(ProjectThreadCount)),
});
export type GetSidebarThreadCatalogResult = typeof GetSidebarThreadCatalogResult.Type;
