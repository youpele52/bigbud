import { OrchestrationReadModel, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import {
  ProjectionOperationalStateQuery,
  type ProjectionOperationalStateQueryShape,
} from "../Services/ProjectionOperationalStateQuery.ts";
import {
  STARTUP_OPERATIONAL_ACTIVITY_LIMIT,
  STARTUP_OPERATIONAL_MESSAGE_LIMIT,
  makeStartupOperationalWindowSql,
} from "./ProjectionOperationalStateQuery.sql.ts";
import { makeProjectOperationalStateSql } from "./ProjectionOperationalStateQuery.projectSql.ts";
import { makeThreadOperationalStateSql } from "./ProjectionOperationalStateQuery.threadSql.ts";
import { assembleSnapshotRows } from "./ProjectionSnapshotQueryAssembly.snapshot.ts";
import { makeProjectionSnapshotQuerySql } from "./ProjectionSnapshotQuerySql.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);

function mapQueryError(operation: string) {
  return (error: unknown) => {
    if (isPersistenceError(error)) {
      return error;
    }
    return Schema.isSchemaError(error)
      ? toPersistenceDecodeError(`${operation}:decode`)(error)
      : toPersistenceSqlError(`${operation}:query`)(error);
  };
}

const makeProjectionOperationalStateQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const snapshotSql = makeProjectionSnapshotQuerySql(sql);
  const startupWindowSql = makeStartupOperationalWindowSql(sql);
  const threadSql = makeThreadOperationalStateSql(sql);
  const projectSql = makeProjectOperationalStateSql(sql);

  const getStartupOperationalState: ProjectionOperationalStateQueryShape["getStartupOperationalState"] =
    () =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* Effect.all(
              {
                projectRows: startupWindowSql.listOperationalProjectRows(undefined),
                threadRows: startupWindowSql.listOperationalThreadRows(undefined),
                messageRows: startupWindowSql.listActiveThreadMessageRows(undefined),
                activityRows: startupWindowSql.listActiveThreadActivityRows(undefined),
                taskRows: startupWindowSql.listActiveThreadTaskRows(undefined),
                sessionRows: startupWindowSql.listOperationalSessionRows(undefined),
                latestTurnRows: startupWindowSql.listOperationalLatestTurnRows(undefined),
                stateRows: snapshotSql.listProjectionStateRows(undefined),
                threadWatchRows: snapshotSql.listThreadWatchRows(undefined),
              },
              { concurrency: 1 },
            );
            return yield* decodeReadModel(
              assembleSnapshotRows({
                ...rows,
                proposedPlanRows: [],
                checkpointRows: [],
              }),
            );
          }),
        )
        .pipe(
          Effect.mapError(
            mapQueryError("ProjectionOperationalStateQuery.getStartupOperationalState"),
          ),
        );

  const readThread = (
    threadId: ThreadId,
    includeHistory: boolean,
  ): ReturnType<ProjectionOperationalStateQueryShape["getThreadOperationalState"]> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* Effect.all(
            {
              projectRows: threadSql.listProjectRows({ threadId }),
              threadRows: threadSql.listThreadRows({ threadId }),
              messageRows: includeHistory
                ? threadSql.listAllThreadMessageRows({ threadId })
                : threadSql.listThreadMessageRows({
                    threadId,
                    limit: STARTUP_OPERATIONAL_MESSAGE_LIMIT,
                  }),
              activityRows: includeHistory
                ? threadSql.listAllThreadActivityRows({ threadId })
                : threadSql.listThreadActivityRows({
                    threadId,
                    limit: STARTUP_OPERATIONAL_ACTIVITY_LIMIT,
                  }),
              taskRows: threadSql.listThreadTaskRows({ threadId }),
              sessionRows: threadSql.listThreadSessionRows({ threadId }),
              latestTurnRows: threadSql.listLatestTurnRows({ threadId }),
              stateRows: threadSql.listProjectionStateRows(undefined),
              threadWatchRows: threadSql.listThreadWatchRows({ threadId }),
              proposedPlanRows: includeHistory
                ? threadSql.listThreadProposedPlanRows({ threadId })
                : Effect.succeed([]),
              checkpointRows: includeHistory
                ? threadSql.listCheckpointRows({ threadId })
                : Effect.succeed([]),
            },
            { concurrency: 1 },
          );
          if (rows.threadRows.length === 0) {
            return Option.none<OrchestrationReadModel>();
          }
          const readModel = yield* decodeReadModel(assembleSnapshotRows(rows));
          return Option.some(readModel);
        }),
      )
      .pipe(
        Effect.mapError(
          mapQueryError(
            includeHistory
              ? "ProjectionOperationalStateQuery.getFullThreadHistory"
              : "ProjectionOperationalStateQuery.getThreadOperationalState",
          ),
        ),
      );

  const getProjectOperationalState: ProjectionOperationalStateQueryShape["getProjectOperationalState"] =
    (projectId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const projectRows = yield* projectSql.listProjectRowsById({ projectId });
            if (projectRows.length === 0) return Option.none<OrchestrationReadModel>();
            const stateRows = yield* threadSql.listProjectionStateRows(undefined);
            const readModel = yield* decodeReadModel(
              assembleSnapshotRows({
                projectRows,
                threadRows: [],
                messageRows: [],
                proposedPlanRows: [],
                activityRows: [],
                taskRows: [],
                sessionRows: [],
                checkpointRows: [],
                latestTurnRows: [],
                stateRows,
                threadWatchRows: [],
              }),
            );
            return Option.some(readModel);
          }),
        )
        .pipe(
          Effect.mapError(
            mapQueryError("ProjectionOperationalStateQuery.getProjectOperationalState"),
          ),
        );

  return {
    getStartupOperationalState,
    getThreadOperationalState: (threadId) => readThread(threadId, false),
    getFullThreadHistory: (threadId) => readThread(threadId, true),
    getProjectOperationalState,
    listProjectThreadIds: (projectId) =>
      projectSql.listProjectThreadIds({ projectId }).pipe(
        Effect.map((rows) => rows.map((row) => row.threadId as ThreadId)),
        Effect.mapError(mapQueryError("ProjectionOperationalStateQuery.listProjectThreadIds")),
      ),
    listProjectIdsByWorkspaceRoot: (workspaceRoot) =>
      projectSql.listProjectIdsByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.map((rows) => rows.map((row) => row.projectId as ProjectId)),
        Effect.mapError(
          mapQueryError("ProjectionOperationalStateQuery.listProjectIdsByWorkspaceRoot"),
        ),
      ),
  } satisfies ProjectionOperationalStateQueryShape;
});

export const ProjectionOperationalStateQueryLive = Layer.effect(
  ProjectionOperationalStateQuery,
  makeProjectionOperationalStateQuery,
);
