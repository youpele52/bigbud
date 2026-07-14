import { IsoDateTime } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import type {
  ProjectionSnapshotQueryShape,
  ProjectionUsageEntry,
} from "../Services/ProjectionSnapshotQuery.ts";

const ProjectionUsageQueryInput = Schema.Struct({
  rangeStart: IsoDateTime,
});

const ProjectionUsageEntryRow = Schema.Struct({
  createdAt: IsoDateTime,
  provider: Schema.String,
  model: Schema.String,
  interactionMode: Schema.String,
  usedTokens: Schema.Number,
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningOutputTokens: Schema.Number,
});

function toUsageQueryError(cause: unknown) {
  return Schema.isSchemaError(cause)
    ? toPersistenceDecodeError("ProjectionSnapshotQuery.getUsageEntries:decodeRows")(cause)
    : toPersistenceSqlError("ProjectionSnapshotQuery.getUsageEntries:query")(cause);
}

export function makeGetUsageEntries(
  sql: SqlClient.SqlClient,
): ProjectionSnapshotQueryShape["getUsageEntries"] {
  const listAllUsageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionUsageEntryRow,
    execute: () => sql`
      SELECT
        activity.created_at AS "createdAt",
        COALESCE(json_extract(thread.model_selection_json, '$.provider'), 'unknown') AS provider,
        COALESCE(json_extract(thread.model_selection_json, '$.model'), 'unknown') AS model,
        thread.interaction_mode AS "interactionMode",
        CAST(json_extract(activity.payload_json, '$.usedTokens') AS INTEGER) AS "usedTokens",
        CASE
          WHEN json_type(activity.payload_json, '$.inputTokens') IN ('integer', 'real')
            AND json_extract(activity.payload_json, '$.inputTokens') > 0
          THEN CAST(json_extract(activity.payload_json, '$.inputTokens') AS INTEGER)
          ELSE 0
        END AS "inputTokens",
        CASE
          WHEN json_type(activity.payload_json, '$.cachedInputTokens') IN ('integer', 'real')
            AND json_extract(activity.payload_json, '$.cachedInputTokens') > 0
          THEN CAST(json_extract(activity.payload_json, '$.cachedInputTokens') AS INTEGER)
          ELSE 0
        END AS "cachedInputTokens",
        CASE
          WHEN json_type(activity.payload_json, '$.outputTokens') IN ('integer', 'real')
            AND json_extract(activity.payload_json, '$.outputTokens') > 0
          THEN CAST(json_extract(activity.payload_json, '$.outputTokens') AS INTEGER)
          ELSE 0
        END AS "outputTokens",
        CASE
          WHEN json_type(activity.payload_json, '$.reasoningOutputTokens') IN ('integer', 'real')
            AND json_extract(activity.payload_json, '$.reasoningOutputTokens') > 0
          THEN CAST(json_extract(activity.payload_json, '$.reasoningOutputTokens') AS INTEGER)
          ELSE 0
        END AS "reasoningOutputTokens"
      FROM projection_thread_activities AS activity
      INNER JOIN projection_threads AS thread ON thread.thread_id = activity.thread_id
      WHERE activity.kind = 'context-window.updated'
        AND json_type(activity.payload_json, '$.usedTokens') IN ('integer', 'real')
        AND CAST(json_extract(activity.payload_json, '$.usedTokens') AS INTEGER) > 0
      ORDER BY activity.created_at ASC, activity.activity_id ASC
    `,
  });

  const listRangedUsageRows = SqlSchema.findAll({
    Request: ProjectionUsageQueryInput,
    Result: ProjectionUsageEntryRow,
    execute: ({ rangeStart }) => sql`
      SELECT
        activity.created_at AS "createdAt",
        COALESCE(json_extract(thread.model_selection_json, '$.provider'), 'unknown') AS provider,
        COALESCE(json_extract(thread.model_selection_json, '$.model'), 'unknown') AS model,
        thread.interaction_mode AS "interactionMode",
        CAST(json_extract(activity.payload_json, '$.usedTokens') AS INTEGER) AS "usedTokens",
        CASE
          WHEN json_type(activity.payload_json, '$.inputTokens') IN ('integer', 'real')
            AND json_extract(activity.payload_json, '$.inputTokens') > 0
          THEN CAST(json_extract(activity.payload_json, '$.inputTokens') AS INTEGER)
          ELSE 0
        END AS "inputTokens",
        CASE
          WHEN json_type(activity.payload_json, '$.cachedInputTokens') IN ('integer', 'real')
            AND json_extract(activity.payload_json, '$.cachedInputTokens') > 0
          THEN CAST(json_extract(activity.payload_json, '$.cachedInputTokens') AS INTEGER)
          ELSE 0
        END AS "cachedInputTokens",
        CASE
          WHEN json_type(activity.payload_json, '$.outputTokens') IN ('integer', 'real')
            AND json_extract(activity.payload_json, '$.outputTokens') > 0
          THEN CAST(json_extract(activity.payload_json, '$.outputTokens') AS INTEGER)
          ELSE 0
        END AS "outputTokens",
        CASE
          WHEN json_type(activity.payload_json, '$.reasoningOutputTokens') IN ('integer', 'real')
            AND json_extract(activity.payload_json, '$.reasoningOutputTokens') > 0
          THEN CAST(json_extract(activity.payload_json, '$.reasoningOutputTokens') AS INTEGER)
          ELSE 0
        END AS "reasoningOutputTokens"
      FROM projection_thread_activities AS activity
      INNER JOIN projection_threads AS thread ON thread.thread_id = activity.thread_id
      WHERE activity.kind = 'context-window.updated'
        AND activity.created_at >= ${rangeStart}
        AND json_type(activity.payload_json, '$.usedTokens') IN ('integer', 'real')
        AND CAST(json_extract(activity.payload_json, '$.usedTokens') AS INTEGER) > 0
      ORDER BY activity.created_at ASC, activity.activity_id ASC
    `,
  });

  return (rangeStart) =>
    (rangeStart === null ? listAllUsageRows(undefined) : listRangedUsageRows({ rangeStart })).pipe(
      Effect.mapError(toUsageQueryError),
      Effect.map((rows): ReadonlyArray<ProjectionUsageEntry> => rows),
    );
}
