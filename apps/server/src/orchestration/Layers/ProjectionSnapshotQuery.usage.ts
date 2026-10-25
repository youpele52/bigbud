import { IsoDateTime } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { EFFECTIVE_USAGE_CTE } from "./ProjectionSnapshotQuery.usage.effective.ts";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import type {
  ProjectionSnapshotQueryShape,
  ProjectionUsageEntry,
} from "../Services/ProjectionSnapshotQuery.ts";

const ProjectionUsageQueryInput = Schema.Struct({
  rangeStart: IsoDateTime,
});

const ProjectionUsageEntryRow = Schema.Struct({
  accountingJson: Schema.NullOr(Schema.String),
  source: Schema.Literals(["provider-reported", "estimated"]),
  contributionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
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

const ProjectionUsageBackfillStateRow = Schema.Struct({ completed: Schema.Number });

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
      ${sql.literal(EFFECTIVE_USAGE_CTE)}
      SELECT
        contribution.accounting_json AS "accountingJson", contribution.source,
        contribution.contribution_id AS "contributionId",
        contribution.thread_id AS "threadId",
        contribution.turn_id AS "turnId",
        contribution.occurred_at AS "createdAt",
        contribution.provider,
        contribution.model,
        contribution.interaction_mode AS "interactionMode",
        contribution.used_tokens AS "usedTokens",
        contribution.input_tokens AS "inputTokens",
        contribution.cached_input_tokens AS "cachedInputTokens",
        contribution.output_tokens AS "outputTokens",
        contribution.reasoning_output_tokens AS "reasoningOutputTokens"
      FROM effective AS contribution
      ORDER BY contribution.occurred_at ASC, contribution.contribution_id ASC
    `,
  });

  const listRangedUsageRows = SqlSchema.findAll({
    Request: ProjectionUsageQueryInput,
    Result: ProjectionUsageEntryRow,
    execute: ({ rangeStart }) => sql`
      ${sql.literal(EFFECTIVE_USAGE_CTE)}
      SELECT
        contribution.accounting_json AS "accountingJson", contribution.source,
        contribution.contribution_id AS "contributionId",
        contribution.thread_id AS "threadId",
        contribution.turn_id AS "turnId",
        contribution.occurred_at AS "createdAt",
        contribution.provider,
        contribution.model,
        contribution.interaction_mode AS "interactionMode",
        contribution.used_tokens AS "usedTokens",
        contribution.input_tokens AS "inputTokens",
        contribution.cached_input_tokens AS "cachedInputTokens",
        contribution.output_tokens AS "outputTokens",
        contribution.reasoning_output_tokens AS "reasoningOutputTokens"
      FROM effective AS contribution
      WHERE contribution.occurred_at >= ${rangeStart}
      ORDER BY contribution.occurred_at ASC, contribution.contribution_id ASC
    `,
  });

  return (rangeStart) =>
    (rangeStart === null ? listAllUsageRows(undefined) : listRangedUsageRows({ rangeStart })).pipe(
      Effect.mapError(toUsageQueryError),
      Effect.map((rows): ReadonlyArray<ProjectionUsageEntry> => rows),
    );
}

export function makeGetUsageHistoryStatus(
  sql: SqlClient.SqlClient,
): ProjectionSnapshotQueryShape["getUsageHistoryStatus"] {
  const getState = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionUsageBackfillStateRow,
    execute: () => sql`
      SELECT completed * (SELECT completed FROM projection_usage_estimate_backfill_state WHERE id = 1) AS completed
      FROM projection_usage_backfill_state
      WHERE id = 1
    `,
  });

  return () =>
    getState(undefined).pipe(
      Effect.map((row) => (row.completed === 1 ? "ready" : "building")),
      Effect.mapError(toUsageQueryError),
    );
}

export function makeGetUsageActiveDays(
  sql: SqlClient.SqlClient,
): ProjectionSnapshotQueryShape["getUsageActiveDays"] {
  const listDays = SqlSchema.findAll({
    Request: Schema.Struct({ before: IsoDateTime }),
    Result: Schema.Struct({ day: Schema.String }),
    execute: ({ before }) => sql`
      ${sql.literal(EFFECTIVE_USAGE_CTE)}
      SELECT DISTINCT date(occurred_at) AS day
      FROM effective
      WHERE used_tokens > 0 AND occurred_at < ${before} AND date(occurred_at) IS NOT NULL
    `,
  });
  return (before) =>
    listDays({ before }).pipe(
      Effect.map((rows) => rows.map((row) => row.day)),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError("ProjectionSnapshotQuery.getUsageActiveDays:decodeRows")(cause)
          : toPersistenceSqlError("ProjectionSnapshotQuery.getUsageActiveDays:query")(cause),
      ),
    );
}
