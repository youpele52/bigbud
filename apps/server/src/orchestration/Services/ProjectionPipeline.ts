/**
 * OrchestrationProjectionPipeline - Event projection pipeline service interface.
 *
 * Coordinates projection bootstrap/replay and per-event projection updates for
 * orchestration read models.
 *
 * @module OrchestrationProjectionPipeline
 */
import type { OrchestrationEvent } from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/**
 * OrchestrationProjectionPipelineShape - Service API for projection execution.
 */
export interface OrchestrationProjectionPipelineShape {
  /**
   * Bootstrap projections by replaying persisted events.
   *
   * Resumes each projector from its stored projection-state cursor.
   */
  readonly bootstrap: Effect.Effect<void, ProjectionRepositoryError>;

  /** Backfill historical canonical usage in bounded, resumable batches. */
  readonly backfillUsageContributions: Effect.Effect<void, ProjectionRepositoryError>;

  /** Ensure a verified baseline covers the specified canonical sequence. */
  readonly ensureVerifiedBaselineThrough: (
    sequence: number,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Verify a replacement baseline without compacting the global event prefix. */
  readonly ensureVerifiedBaselineThroughWithoutCompaction?: (
    sequence: number,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Delete at most one bounded canonical prefix covered by a verified baseline. */
  readonly compactVerifiedPrefix: (
    batchSize?: number,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project a single orchestration event into projection repositories.
   *
   * Projectors are executed sequentially to preserve deterministic ordering.
   */
  readonly projectEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * OrchestrationProjectionPipeline - Service tag for orchestration projections.
 */
export class OrchestrationProjectionPipeline extends ServiceMap.Service<
  OrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineShape
>()("t3/orchestration/Services/ProjectionPipeline/OrchestrationProjectionPipeline") {}
