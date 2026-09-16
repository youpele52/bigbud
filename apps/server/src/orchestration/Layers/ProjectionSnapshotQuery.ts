import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isPersistenceError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { makeProjectionSnapshotQuerySql } from "./ProjectionSnapshotQuerySql.ts";
import { makeMobileProjectionSnapshotQuerySql } from "./ProjectionSnapshotQuery.mobileSql.ts";
import {
  assembleSnapshot,
  makeGetCounts,
  makeGetActiveProjectByWorkspaceRoot,
  makeGetFirstActiveThreadIdByProjectId,
  makeGetThreadCheckpointContext,
} from "./ProjectionSnapshotQueryAssembly.ts";
import { makeGetMobileRecoveryBaseline } from "./ProjectionSnapshotQuery.mobileAssembly.ts";
import { makeGetUsageEntries, makeGetUsageHistoryStatus } from "./ProjectionSnapshotQuery.usage.ts";

// Re-export for backward compat (used in tests / other modules)
export { toPersistenceSqlOrDecodeError } from "./ProjectionSnapshotQueryAssembly.ts";

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queries = makeProjectionSnapshotQuerySql(sql);
  const mobileQueries = makeMobileProjectionSnapshotQuerySql(sql);

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql.withTransaction(assembleSnapshot(queries)).pipe(
      Effect.mapError((error) => {
        if (isPersistenceError(error)) {
          return error;
        }
        return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
      }),
    );

  const getMobileRecoveryBaseline: NonNullable<
    ProjectionSnapshotQueryShape["getMobileRecoveryBaseline"]
  > = (selectedThreadId) =>
    sql
      .withTransaction(makeGetMobileRecoveryBaseline(queries, mobileQueries)(selectedThreadId))
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getMobileRecoveryBaseline:query")(
            error,
          );
        }),
      );

  return {
    getSnapshot,
    getMobileRecoveryBaseline,
    getCounts: makeGetCounts(queries),
    getUsageEntries: makeGetUsageEntries(sql),
    getUsageHistoryStatus: makeGetUsageHistoryStatus(sql),
    getActiveProjectByWorkspaceRoot: makeGetActiveProjectByWorkspaceRoot(queries),
    getFirstActiveThreadIdByProjectId: makeGetFirstActiveThreadIdByProjectId(queries),
    getThreadCheckpointContext: makeGetThreadCheckpointContext(queries),
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
