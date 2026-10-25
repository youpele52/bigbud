import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@bigbud/contracts";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import { assertProjectionThreadParent } from "./ProjectionThreadOwnership.ts";
import { makeListPendingDelegatedModelChoiceRequests } from "./ProjectionThreads.modelChoice.ts";
import { reducePersistedCodexUsage, retireCodexUsageTurns } from "./ProjectionUsageCodex.ts";
import { makeUpsertUsageContribution } from "./ProjectionUsageContributions.upsert.ts";

import {
  DeleteProjectionThreadActivitiesInput,
  ListProjectionUsageBackfillBatchInput,
  ListProjectionThreadActivitiesInput,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
  ProjectionUsageBackfillRow,
  ProjectionUsageBackfillState,
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

  const deleteProjectionUsageContributionRows = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesInput,
    execute: ({ threadId }) =>
      sql`DELETE FROM projection_usage_contributions WHERE thread_id = ${threadId}`,
  });

  const upsertProjectionUsageContributionRow = makeUpsertUsageContribution(sql);

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
            'unknown'
          ) AS provider,
          COALESCE(
            json_extract(activity.payload_json, '$.accounting.canonical.model'),
            usage_turn.usage_model,
            'unknown'
          ) AS model,
          COALESCE(
            usage_turn.usage_interaction_mode,
            'default'
          ) AS "interactionMode"
        FROM projection_thread_activities AS activity
        INNER JOIN projection_threads AS thread ON thread.thread_id = activity.thread_id
        LEFT JOIN projection_turns AS usage_turn ON usage_turn.thread_id = activity.thread_id AND usage_turn.turn_id = activity.turn_id
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
    Effect.gen(function* () {
      yield* assertProjectionThreadParent(sql, row.threadId);
      yield* upsertProjectionThreadActivityRow(row);
    }).pipe(
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

  const deleteUsageByThreadId: ProjectionThreadActivityRepositoryShape["deleteUsageByThreadId"] = (
    input,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* deleteProjectionUsageContributionRows(input);
          yield* sql`DELETE FROM projection_usage_codex_state WHERE thread_id = ${input.threadId}`;
          yield* sql`DELETE FROM projection_usage_codex_retired_turns WHERE thread_id = ${input.threadId}`;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadActivityRepository.deleteUsageByThreadId:query"),
        ),
      );

  const upsertUsageContribution: ProjectionThreadActivityRepositoryShape["upsertUsageContribution"] =
    (row) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const next = yield* reducePersistedCodexUsage(sql, row);
            if (next) yield* upsertProjectionUsageContributionRow(next);
          }),
        )
        .pipe(
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
    retireUsageTurns: (threadId, turnIds) => retireCodexUsageTurns(sql, threadId, turnIds),
    upsert,
    listByThreadId,
    deleteByThreadId,
    deleteUsageByThreadId,
    upsertUsageContribution,
    getUsageBackfillState,
    listUsageBackfillBatch,
    advanceUsageBackfillState,
    listPendingDelegatedModelChoiceRequests: makeListPendingDelegatedModelChoiceRequests(sql),
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
