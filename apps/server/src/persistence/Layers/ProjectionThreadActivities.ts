import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@bigbud/contracts";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadActivitiesInput,
  ListProjectionUsageBackfillBatchInput,
  ListProjectionThreadActivitiesInput,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
  ProjectionUsageBackfillRow,
  ProjectionUsageBackfillState,
  ProjectionUsageContribution,
  type ProjectionThreadActivityRepositoryShape,
} from "../Services/ProjectionThreadActivities.ts";

const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

const ProjectionUsageBackfillRowDbSchema = ProjectionUsageBackfillRow.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

const ProjectionUsageBackfillStateDbSchema = ProjectionUsageBackfillState.mapFields(
  Struct.assign({ completed: NonNegativeInt }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadActivityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadActivityRow = SqlSchema.void({
    Request: ProjectionThreadActivity,
    execute: (row) =>
      sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              created_at
            )
            VALUES (
              ${row.activityId},
              ${row.threadId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${JSON.stringify(row.payload)},
              ${row.sequence ?? null},
              ${row.createdAt}
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              tone = excluded.tone,
              kind = excluded.kind,
              summary = excluded.summary,
              payload_json = excluded.payload_json,
              sequence = excluded.sequence,
              created_at = excluded.created_at
          `,
  });

  const listProjectionThreadActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const deleteProjectionThreadActivityRows = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `,
  });

  const upsertProjectionUsageContributionRow = SqlSchema.void({
    Request: ProjectionUsageContribution,
    execute: (row) =>
      sql`
        INSERT INTO projection_usage_contributions (
          contribution_id,
          activity_id,
          thread_id,
          turn_id,
          provider,
          model,
          interaction_mode,
          occurred_at,
          used_tokens,
          input_tokens,
          cached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          finalized,
          source_sequence,
          updated_at
        )
        VALUES (
          ${row.contributionId},
          ${row.activityId},
          ${row.threadId},
          ${row.turnId},
          ${row.provider},
          ${row.model},
          ${row.interactionMode},
          ${row.occurredAt},
          ${row.usedTokens},
          ${row.inputTokens},
          ${row.cachedInputTokens},
          ${row.outputTokens},
          ${row.reasoningOutputTokens},
          ${row.finalized ? 1 : 0},
          ${row.sourceSequence},
          ${row.updatedAt}
        )
        ON CONFLICT (contribution_id)
        DO UPDATE SET
          activity_id = excluded.activity_id,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          provider = excluded.provider,
          model = excluded.model,
          interaction_mode = excluded.interaction_mode,
          occurred_at = excluded.occurred_at,
          used_tokens = excluded.used_tokens,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          finalized = excluded.finalized,
          source_sequence = excluded.source_sequence,
          updated_at = excluded.updated_at
        WHERE (
            excluded.source_sequence IS NOT NULL
            AND (
              projection_usage_contributions.source_sequence IS NULL
              OR excluded.source_sequence >= projection_usage_contributions.source_sequence
            )
          )
          OR (
            excluded.source_sequence IS NULL
            AND projection_usage_contributions.source_sequence IS NULL
            AND excluded.updated_at >= projection_usage_contributions.updated_at
          )
      `,
  });

  const getProjectionUsageBackfillStateRow = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionUsageBackfillStateDbSchema,
    execute: () =>
      sql`
        SELECT
          last_activity_id AS "lastActivityId",
          completed,
          updated_at AS "updatedAt"
        FROM projection_usage_backfill_state
        WHERE id = 1
      `,
  });

  const listProjectionUsageBackfillRows = SqlSchema.findAll({
    Request: ListProjectionUsageBackfillBatchInput,
    Result: ProjectionUsageBackfillRowDbSchema,
    execute: ({ afterActivityId, limit }) =>
      sql`
        SELECT
          activity.activity_id AS "activityId",
          activity.kind,
          activity.thread_id AS "threadId",
          activity.turn_id AS "turnId",
          activity.payload_json AS payload,
          activity.sequence,
          activity.created_at AS "createdAt",
          COALESCE(
            json_extract(activity.payload_json, '$.accounting.provider'),
            json_extract(thread.model_selection_json, '$.provider'),
            'unknown'
          ) AS provider,
          COALESCE(
            json_extract(activity.payload_json, '$.accounting.model'),
            json_extract(thread.model_selection_json, '$.model'),
            'unknown'
          ) AS model,
          COALESCE(
            json_extract(activity.payload_json, '$.accounting.interactionMode'),
            thread.interaction_mode,
            'default'
          ) AS "interactionMode"
        FROM projection_thread_activities AS activity
        INNER JOIN projection_threads AS thread ON thread.thread_id = activity.thread_id
        WHERE activity.activity_id > ${afterActivityId}
        ORDER BY activity.activity_id ASC
        LIMIT ${limit}
      `,
  });

  const advanceProjectionUsageBackfillStateRow = SqlSchema.void({
    Request: ProjectionUsageBackfillState,
    execute: (state) =>
      sql`
        UPDATE projection_usage_backfill_state
        SET
          last_activity_id = ${state.lastActivityId},
          completed = ${state.completed ? 1 : 0},
          updated_at = ${state.updatedAt}
        WHERE id = 1
      `,
  });

  const upsert: ProjectionThreadActivityRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadActivityRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.upsert:query",
          "ProjectionThreadActivityRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadActivityRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.listByThreadId:query",
          "ProjectionThreadActivityRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          activityId: row.activityId,
          threadId: row.threadId,
          turnId: row.turnId,
          tone: row.tone,
          kind: row.kind,
          summary: row.summary,
          payload: row.payload,
          ...(row.sequence !== null ? { sequence: row.sequence } : {}),
          createdAt: row.createdAt,
        })),
      ),
    );

  const deleteByThreadId: ProjectionThreadActivityRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadActivityRepository.deleteByThreadId:query"),
      ),
    );

  const upsertUsageContribution: ProjectionThreadActivityRepositoryShape["upsertUsageContribution"] =
    (row) =>
      upsertProjectionUsageContributionRow(row).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.upsertUsageContribution:query",
            "ProjectionThreadActivityRepository.upsertUsageContribution:encodeRequest",
          ),
        ),
      );

  const getUsageBackfillState: ProjectionThreadActivityRepositoryShape["getUsageBackfillState"] =
    () =>
      getProjectionUsageBackfillStateRow(undefined).pipe(
        Effect.map((row) => ({ ...row, completed: row.completed === 1 })),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.getUsageBackfillState:query",
            "ProjectionThreadActivityRepository.getUsageBackfillState:decodeRow",
          ),
        ),
      );

  const listUsageBackfillBatch: ProjectionThreadActivityRepositoryShape["listUsageBackfillBatch"] =
    (input) =>
      listProjectionUsageBackfillRows(input).pipe(
        Effect.map((rows) =>
          rows.map((row) => {
            const { sequence, ...rest } = row;
            return {
              ...rest,
              ...(sequence !== null ? { sequence } : {}),
            };
          }),
        ),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.listUsageBackfillBatch:query",
            "ProjectionThreadActivityRepository.listUsageBackfillBatch:decodeRows",
          ),
        ),
      );

  const advanceUsageBackfillState: ProjectionThreadActivityRepositoryShape["advanceUsageBackfillState"] =
    (state) =>
      advanceProjectionUsageBackfillStateRow(state).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.advanceUsageBackfillState:query",
            "ProjectionThreadActivityRepository.advanceUsageBackfillState:encodeRequest",
          ),
        ),
      );

  return {
    upsert,
    listByThreadId,
    deleteByThreadId,
    upsertUsageContribution,
    getUsageBackfillState,
    listUsageBackfillBatch,
    advanceUsageBackfillState,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
