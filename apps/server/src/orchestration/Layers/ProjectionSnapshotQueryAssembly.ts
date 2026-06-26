/**
 * Assembles the OrchestrationReadModel from raw DB rows fetched by
 * ProjectionSnapshotQuerySql query builders.
 *
 * All row-to-domain mapping and cross-cutting assembly logic lives here.
 */
import { OrchestrationReadModel, type OrchestrationProject } from "@bigbud/contracts";
import { Effect, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import {
  assembleSnapshotRows,
  mapCheckpointRow,
  mapProjectRow,
} from "./ProjectionSnapshotQueryAssembly.snapshot.ts";
import { type ProjectionSnapshotQuerySql } from "./ProjectionSnapshotQuerySql.ts";
import {
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);

export function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

// ---------------------------------------------------------------------------
// Assembly functions
// ---------------------------------------------------------------------------

/**
 * Builds the OrchestrationReadModel from raw DB rows fetched by the query
 * builders.  Intended to be run inside a SQL transaction by the caller.
 */
export function assembleSnapshot(queries: ProjectionSnapshotQuerySql) {
  return Effect.gen(function* () {
    const [
      projectRows,
      threadRows,
      messageRows,
      proposedPlanRows,
      activityRows,
      sessionRows,
      checkpointRows,
      latestTurnRows,
      stateRows,
      threadWatchRows,
    ] = yield* Effect.all([
      queries
        .listProjectRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
              "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadMessageRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadProposedPlanRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadActivityRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadSessionRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
            ),
          ),
        ),
      queries
        .listCheckpointRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
              "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
            ),
          ),
        ),
      queries
        .listLatestTurnRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
              "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
            ),
          ),
        ),
      queries
        .listProjectionStateRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
              "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadWatchRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreadWatches:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreadWatches:decodeRows",
            ),
          ),
        ),
    ]);

    const snapshot = assembleSnapshotRows({
      projectRows,
      threadRows,
      messageRows,
      proposedPlanRows,
      activityRows,
      sessionRows,
      checkpointRows,
      latestTurnRows,
      stateRows,
      threadWatchRows,
    });

    return yield* decodeReadModel(snapshot).pipe(
      Effect.mapError(
        toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
      ),
    );
  });
}

/** Assembles getCounts. */
export function makeGetCounts(
  queries: ProjectionSnapshotQuerySql,
): ProjectionSnapshotQueryShape["getCounts"] {
  return () =>
    queries.readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );
}

/** Assembles getActiveProjectByWorkspaceRoot. */
export function makeGetActiveProjectByWorkspaceRoot(
  queries: ProjectionSnapshotQuerySql,
): ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] {
  return (workspaceRoot) =>
    queries
      .getActiveProjectRowByWorkspaceRoot({ workspaceRoot })
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.map(Option.map((row): OrchestrationProject => mapProjectRow(row))),
      );
}

/** Assembles getFirstActiveThreadIdByProjectId. */
export function makeGetFirstActiveThreadIdByProjectId(
  queries: ProjectionSnapshotQuerySql,
): ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] {
  return (projectId) =>
    queries
      .getFirstActiveThreadIdByProject({ projectId })
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );
}

/** Assembles getThreadCheckpointContext. */
export function makeGetThreadCheckpointContext(
  queries: ProjectionSnapshotQuerySql,
): ProjectionSnapshotQueryShape["getThreadCheckpointContext"] {
  return (threadId) =>
    Effect.gen(function* () {
      const threadRow = yield* queries
        .getThreadCheckpointContextThreadRow({ threadId })
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
              "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
            ),
          ),
        );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* queries
        .listCheckpointRowsByThread({ threadId })
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
            ),
          ),
        );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        executionTargetId: threadRow.value.executionTargetId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(mapCheckpointRow),
      });
    });
}
