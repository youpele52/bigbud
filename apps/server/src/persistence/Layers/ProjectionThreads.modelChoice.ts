/**
 * Read models for delegated model choice: server-derived model recency (D7) and the restart sweep
 * of unresolved holds (D8). Both use existing indexes and never touch the event store. The sweep
 * has no age cutoff, so no hold is ever stranded pending (D-20).
 *
 * @module ProjectionThreads.modelChoice
 */
import { EventId, IsoDateTime, ThreadId } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { unresolvedModelChoiceRequestsCtes } from "../DelegatedModelChoiceSql.ts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  ListRecentModelSelectionsInput,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import {
  ListPendingDelegatedModelChoiceRequestsInput,
  type ProjectionThreadActivityRepositoryShape,
} from "../Services/ProjectionThreadActivities.ts";

const RecentModelSelectionRow = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  subProviderID: Schema.NullOr(Schema.String),
  lastUsedAt: IsoDateTime,
});

const PendingRequestRow = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
  createdAt: IsoDateTime,
  payload: Schema.fromJsonString(Schema.Unknown),
});

export function makeListRecentModelSelections(
  sql: SqlClient.SqlClient,
): ProjectionThreadRepositoryShape["listRecentModelSelections"] {
  const query = SqlSchema.findAll({
    Request: ListRecentModelSelectionsInput,
    Result: RecentModelSelectionRow,
    execute: ({ limit }) => sql`
      SELECT
        json_extract(model_selection_json, '$.provider') AS provider,
        json_extract(model_selection_json, '$.model') AS model,
        json_extract(model_selection_json, '$.subProviderID') AS "subProviderID",
        MAX(COALESCE(last_activity_at, updated_at)) AS "lastUsedAt"
      FROM projection_threads
      WHERE deleted_at IS NULL
        AND latest_turn_id IS NOT NULL
        AND json_extract(model_selection_json, '$.provider') IS NOT NULL
        AND json_extract(model_selection_json, '$.model') IS NOT NULL
      GROUP BY provider, model, "subProviderID"
      ORDER BY "lastUsedAt" DESC, provider ASC, model ASC
      LIMIT ${limit}
    `,
  });
  return (input) =>
    query(input).pipe(
      Effect.map((rows) =>
        rows.map(({ subProviderID, ...row }) =>
          subProviderID === null ? row : { ...row, subProviderID },
        ),
      ),
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadRepository.listRecentModelSelections:query"),
      ),
    );
}

export function makeListPendingDelegatedModelChoiceRequests(
  sql: SqlClient.SqlClient,
): ProjectionThreadActivityRepositoryShape["listPendingDelegatedModelChoiceRequests"] {
  const query = SqlSchema.findAll({
    Request: ListPendingDelegatedModelChoiceRequestsInput,
    Result: PendingRequestRow,
    execute: ({ limit, after }) => sql`
      WITH ${unresolvedModelChoiceRequestsCtes(sql)}
      SELECT
        requested.thread_id AS "threadId", requested.activity_id AS "activityId",
        requested.created_at AS "createdAt", requested.payload_json AS payload
      FROM model_choice_unresolved requested
      JOIN projection_threads thread ON thread.thread_id = requested.thread_id
      WHERE thread.deleted_at IS NULL
        -- A deleting thread rejects resolution; its deletion removes the hold (M4).
        AND thread.deleting_at IS NULL
        AND (
          ${after === undefined ? 1 : 0} = 1
          OR requested.created_at > ${after?.createdAt ?? ""}
          OR (
            requested.created_at = ${after?.createdAt ?? ""}
            AND requested.activity_id > ${after?.activityId ?? ""}
          )
        )
      ORDER BY requested.created_at ASC, requested.activity_id ASC
      LIMIT ${limit}
    `,
  });
  return (input) =>
    query(input).pipe(
      Effect.mapError(
        toPersistenceSqlError(
          "ProjectionThreadActivityRepository.listPendingDelegatedModelChoiceRequests:query",
        ),
      ),
    );
}
