/**
 * ProjectionThreadActivityRepository - Projection repository interface for thread activity.
 *
 * Owns persistence operations for activity timeline entries projected from
 * orchestration events.
 *
 * @module ProjectionThreadActivityRepository
 */
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProviderInteractionMode,
  OrchestrationThreadActivityTone,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadActivity = Schema.Struct({
  activityId: EventId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  tone: OrchestrationThreadActivityTone,
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type ProjectionThreadActivity = typeof ProjectionThreadActivity.Type;

export const ProjectionUsageContribution = Schema.Struct({
  contributionId: Schema.String,
  activityId: EventId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  provider: Schema.String,
  model: Schema.String,
  interactionMode: ProviderInteractionMode,
  occurredAt: IsoDateTime,
  usedTokens: NonNegativeInt,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
  finalized: Schema.Boolean,
  sourceSequence: Schema.NullOr(NonNegativeInt),
  updatedAt: IsoDateTime,
});
export type ProjectionUsageContribution = typeof ProjectionUsageContribution.Type;

export const ProjectionUsageBackfillState = Schema.Struct({
  lastActivityId: Schema.String,
  completed: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ProjectionUsageBackfillState = typeof ProjectionUsageBackfillState.Type;

export const ProjectionUsageBackfillRow = Schema.Struct({
  activityId: EventId,
  kind: Schema.String,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  payload: Schema.Unknown,
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  provider: Schema.String,
  model: Schema.String,
  interactionMode: ProviderInteractionMode,
});
export type ProjectionUsageBackfillRow = typeof ProjectionUsageBackfillRow.Type;

export const ListProjectionUsageBackfillBatchInput = Schema.Struct({
  afterActivityId: Schema.String,
  limit: NonNegativeInt,
});
export type ListProjectionUsageBackfillBatchInput =
  typeof ListProjectionUsageBackfillBatchInput.Type;

export const ListProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadActivitiesInput = typeof ListProjectionThreadActivitiesInput.Type;

export const DeleteProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadActivitiesInput =
  typeof DeleteProjectionThreadActivitiesInput.Type;

/**
 * ProjectionThreadActivityRepositoryShape - Service API for projected thread activity.
 */
export interface ProjectionThreadActivityRepositoryShape {
  /**
   * Insert or replace a projected thread activity row.
   *
   * Upserts by `activityId` and JSON-encodes payload.
   */
  readonly upsert: (
    row: ProjectionThreadActivity,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected thread activity rows for a thread.
   *
   * Returned in ascending runtime sequence order (or creation order when
   * sequence is unavailable).
   */
  readonly listByThreadId: (
    input: ListProjectionThreadActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * Delete projected thread activity rows by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadActivitiesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Insert or replace a projected usage contribution row.
   */
  readonly upsertUsageContribution: (
    row: ProjectionUsageContribution,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getUsageBackfillState: () => Effect.Effect<
    ProjectionUsageBackfillState,
    ProjectionRepositoryError
  >;

  readonly listUsageBackfillBatch: (
    input: ListProjectionUsageBackfillBatchInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionUsageBackfillRow>, ProjectionRepositoryError>;

  readonly advanceUsageBackfillState: (
    state: ProjectionUsageBackfillState,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadActivityRepository - Service tag for thread activity persistence.
 */
export class ProjectionThreadActivityRepository extends ServiceMap.Service<
  ProjectionThreadActivityRepository,
  ProjectionThreadActivityRepositoryShape
>()("t3/persistence/Services/ProjectionThreadActivities/ProjectionThreadActivityRepository") {}
