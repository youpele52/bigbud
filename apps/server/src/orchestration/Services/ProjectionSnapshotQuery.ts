/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  ExecutionTargetId,
  OrchestrationCheckpointSummary,
  OrchestrationProject,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Option } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionUsageEntry {
  readonly contributionId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly provider: string;
  readonly model: string;
  readonly interactionMode: string;
  readonly usedTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export type ProjectionUsageHistoryStatus = "building" | "ready";

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly executionTargetId: ExecutionTargetId;
  readonly workspaceRoot: string | null;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read projected context-window usage without hydrating the full read model.
   */
  readonly getUsageEntries: (
    rangeStart: string | null,
  ) => Effect.Effect<ReadonlyArray<ProjectionUsageEntry>, ProjectionRepositoryError>;

  readonly getUsageHistoryStatus: () => Effect.Effect<
    ProjectionUsageHistoryStatus,
    ProjectionRepositoryError
  >;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends ServiceMap.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
