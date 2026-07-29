import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { PersistedModelSelection } from "@bigbud/contracts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  LearningJob,
  LearningJobRepository,
  type LearningJobRepositoryShape,
} from "../Services/LearningJobs.ts";

const LearningJobDbRow = Schema.Struct({
  ...LearningJob.fields,
  // Learning rows are historical work items. Keep their provider and
  // selection available for quarantine instead of failing the whole queue.
  provider: Schema.String,
  modelSelection: Schema.fromJsonString(PersistedModelSelection),
});

const LatestMemoryUserMessageCount = Schema.Struct({
  memoryUserMessageCount: Schema.NullOr(Schema.Number),
});

type LearningJobDbRow = typeof LearningJobDbRow.Type;
function normalizeLearningJobRow(row: LearningJobDbRow): typeof LearningJob.Type {
  return row as unknown as typeof LearningJob.Type;
}

const makeLearningJobRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listQueuedRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: LearningJobDbRow,
    execute: () => sql`
      SELECT job_id AS "jobId", thread_id AS "threadId", turn_id AS "turnId",
        provider, model, model_selection_json AS "modelSelection",
        memory_user_message_count AS "memoryUserMessageCount", state,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM learning_jobs WHERE state IN ('queued', 'reviewing') ORDER BY created_at ASC
    `,
  });
  const updateState = SqlSchema.void({
    Request: Schema.Struct({
      jobId: LearningJob.fields.jobId,
      state: LearningJob.fields.state,
      updatedAt: LearningJob.fields.updatedAt,
    }),
    execute: (row) => sql`
      UPDATE learning_jobs SET state = ${row.state}, updated_at = ${row.updatedAt}
      WHERE job_id = ${row.jobId}
    `,
  });
  const getLatestMemoryUserMessageCountRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: LearningJob.fields.threadId }),
    Result: LatestMemoryUserMessageCount,
    execute: ({ threadId }) => sql`
      SELECT memory_user_message_count AS "memoryUserMessageCount"
      FROM learning_jobs
      WHERE thread_id = ${threadId}
        AND memory_user_message_count IS NOT NULL
      ORDER BY memory_user_message_count DESC
      LIMIT 1
    `,
  });

  const mapError = (operation: string) => (error: unknown) =>
    Schema.isSchemaError(error)
      ? toPersistenceDecodeError(`${operation}:decode`)(error)
      : toPersistenceSqlError(`${operation}:query`)(error);

  const createIfAbsent: LearningJobRepositoryShape["createIfAbsent"] = Effect.fn(
    "LearningJobRepository.createIfAbsent",
  )(function* (input) {
    const rows = yield* sql`
      INSERT INTO learning_jobs (
        job_id, thread_id, turn_id, provider, model, model_selection_json,
        memory_user_message_count, state, created_at, updated_at
      ) VALUES (
        ${input.jobId}, ${input.threadId}, ${input.turnId}, ${input.provider}, ${input.model},
        ${JSON.stringify(input.modelSelection)}, ${input.memoryUserMessageCount}, ${input.state},
        ${input.createdAt}, ${input.updatedAt}
      ) ON CONFLICT(thread_id, turn_id) DO NOTHING
      RETURNING job_id
    `.pipe(Effect.mapError(toPersistenceSqlError("LearningJobRepository.createIfAbsent:query")));
    return rows.length > 0;
  });

  const listQueued: LearningJobRepositoryShape["listQueued"] = () =>
    listQueuedRows(undefined).pipe(
      Effect.map((rows) => rows.map(normalizeLearningJobRow)),
      Effect.mapError(mapError("LearningJobRepository.listQueued")),
    );

  const getLatestMemoryUserMessageCount: LearningJobRepositoryShape["getLatestMemoryUserMessageCount"] =
    (input) =>
      getLatestMemoryUserMessageCountRow(input).pipe(
        Effect.mapError(mapError("LearningJobRepository.getLatestMemoryUserMessageCount")),
        Effect.map((row) => (row._tag === "Some" ? row.value.memoryUserMessageCount : null)),
      );

  const setState: LearningJobRepositoryShape["setState"] = (input) =>
    updateState(input).pipe(
      Effect.asVoid,
      Effect.mapError(mapError("LearningJobRepository.setState")),
    );

  return {
    createIfAbsent,
    listQueued,
    getLatestMemoryUserMessageCount,
    setState,
  } satisfies LearningJobRepositoryShape;
});

export const LearningJobRepositoryLive = Layer.effect(
  LearningJobRepository,
  makeLearningJobRepository,
);
