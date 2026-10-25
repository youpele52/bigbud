/**
 * ProjectionThreadRepository - Projection repository interface for threads.
 *
 * Owns persistence operations for projected thread records in the
 * orchestration read model.
 *
 * @module ProjectionThreadRepository
 */
import {
  ElevatorSummary,
  ExecutionTargetId,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  ParentThreadReference,
  OrchestrationThreadPurpose,
  OrchestrationQueuedPrompt,
  OrchestrationPendingInterruptFlushIntent,
  OrchestrationTurnControlOperation,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { ThreadForkOrigin } from "@bigbud/contracts/orchestration/orchestration.fork.ts";
import { OrchestrationPendingTurnStart } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type { ThreadRecovery } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServiceMap from "effect/ServiceMap";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  purpose: OrchestrationThreadPurpose,
  elevatorSummary: Schema.NullOr(ElevatorSummary),
  elevatorSummaryMessageCount: NonNegativeInt,
  providerRuntimeExecutionTargetId: ExecutionTargetId,
  workspaceExecutionTargetId: ExecutionTargetId,
  executionTargetId: ExecutionTargetId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  parentThread: Schema.optional(ParentThreadReference),
  /** Fork lineage; written once at creation and kept by later upserts. */
  forkOrigin: Schema.optional(ThreadForkOrigin),
  latestTurnId: Schema.NullOr(TurnId),
  queuedPrompts: Schema.Array(OrchestrationQueuedPrompt),
  pendingInterruptFlushIntent: Schema.optional(
    Schema.NullOr(OrchestrationPendingInterruptFlushIntent),
  ),
  pendingTurnControlOperation: Schema.optional(Schema.NullOr(OrchestrationTurnControlOperation)),
  queueHold: Schema.optional(Schema.Boolean),
  pendingTurnStart: Schema.optional(Schema.NullOr(OrchestrationPendingTurnStart)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  deletingAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
  threadIds: Schema.optional(Schema.Array(ThreadId)),
  origin: Schema.optional(Schema.Literal("project-cascade")),
});
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type;

export const TouchProjectionThreadActivityInput = Schema.Struct({
  threadId: ThreadId,
  occurredAt: IsoDateTime,
});
export type TouchProjectionThreadActivityInput = typeof TouchProjectionThreadActivityInput.Type;

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type;

/**
 * ProjectionThreadRepositoryShape - Service API for projected thread records.
 */
export const ListRecentModelSelectionsInput = Schema.Struct({ limit: NonNegativeInt });
export type ListRecentModelSelectionsInput = typeof ListRecentModelSelectionsInput.Type;

/** One provider+model+subProviderID, with the latest activity of a started thread using it. */
export interface RecentProjectionModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly subProviderID?: string;
  readonly lastUsedAt: string;
}

export interface ProjectionThreadRepositoryShape {
  /**
   * Insert or replace a projected thread row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread row by id.
   */
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * List projected threads for a project.
   *
   * Returned in deterministic creation order.
   */
  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>;

  /** Detach child references and physically remove a projected thread row by id. */
  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Advance the authoritative retention clock without moving it backwards. */
  readonly touchActivity: (
    input: TouchProjectionThreadActivityInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Models of started, live threads, most recently used first (delegated model choice, D7). */
  readonly listRecentModelSelections: (
    input: ListRecentModelSelectionsInput,
  ) => Effect.Effect<ReadonlyArray<RecentProjectionModelSelection>, ProjectionRepositoryError>;
  /** Sets the thread's sleep and wake recovery notice (`recovery_json`). */
  readonly setRecovery: (input: {
    readonly threadId: ThreadId;
    readonly recovery: ThreadRecovery | null;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadRepository - Service tag for thread projection persistence.
 */
export class ProjectionThreadRepository extends ServiceMap.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("t3/persistence/Services/ProjectionThreads/ProjectionThreadRepository") {}
