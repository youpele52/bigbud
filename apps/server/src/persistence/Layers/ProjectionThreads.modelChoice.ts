/**
 * Read models for delegated model choice: server-derived model recency (D7) and the restart sweep
 * of unresolved holds (D8). Both use existing indexes and never touch the event store.
 *
 * @module ProjectionThreads.modelChoice
 */
import { IsoDateTime, ThreadId } from "@bigbud/contracts";
import {
  DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND,
  DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

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
    execute: ({ limit }) => sql`
      SELECT requested.thread_id AS "threadId", requested.payload_json AS payload
      FROM projection_thread_activities requested
      JOIN projection_threads thread ON thread.thread_id = requested.thread_id
      WHERE requested.kind = ${DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND}
        AND thread.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_activities resolved
          WHERE resolved.thread_id = requested.thread_id
            AND resolved.kind = ${DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND}
            AND json_extract(resolved.payload_json, '$.choiceId') =
              json_extract(requested.payload_json, '$.choiceId')
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
