import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadTask,
  ProjectionThreadTaskLookup,
  ProjectionThreadTasksByThread,
  ProjectionThreadTaskRepository,
  type ProjectionThreadTaskRepositoryShape,
} from "../Services/ProjectionThreadTasks.ts";

const ProjectionThreadTaskDbRow = ProjectionThreadTask.mapFields(
  Struct.assign({ task: Schema.fromJsonString(ProjectionThreadTask.fields.task) }),
);

function mapError(operation: string, decode: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decode)(cause)
      : toPersistenceSqlError(operation)(cause);
}

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadTask,
    execute: (row) => sql`
      INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
      VALUES (${row.taskId}, ${row.threadId}, ${JSON.stringify(row.task)}, ${row.task.createdAt}, ${row.task.updatedAt})
      ON CONFLICT (task_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        task_json = excluded.task_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });
  const getRow = SqlSchema.findOneOption({
    Request: ProjectionThreadTaskLookup,
    Result: ProjectionThreadTaskDbRow,
    execute: ({ taskId }) => sql`
      SELECT task_id AS "taskId", thread_id AS "threadId", task_json AS "task",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_thread_tasks WHERE task_id = ${taskId} LIMIT 1
    `,
  });
  const listRows = SqlSchema.findAll({
    Request: ProjectionThreadTasksByThread,
    Result: ProjectionThreadTaskDbRow,
    execute: ({ threadId }) => sql`
      SELECT task_id AS "taskId", thread_id AS "threadId", task_json AS "task",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_thread_tasks
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, task_id ASC
    `,
  });
  const removeRow = SqlSchema.void({
    Request: ProjectionThreadTaskLookup,
    execute: ({ taskId }) => sql`DELETE FROM projection_thread_tasks WHERE task_id = ${taskId}`,
  });
  const deleteRows = SqlSchema.void({
    Request: ProjectionThreadTasksByThread,
    execute: ({ threadId }) =>
      sql`DELETE FROM projection_thread_tasks WHERE thread_id = ${threadId}`,
  });
  const upsert: ProjectionThreadTaskRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(mapError("ProjectionThreadTaskRepository.upsert", "encode")),
    );
  const getByTaskId: ProjectionThreadTaskRepositoryShape["getByTaskId"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(mapError("ProjectionThreadTaskRepository.getByTaskId", "decode")),
      Effect.map(
        Option.map((row) => ({ taskId: row.taskId, threadId: row.threadId, task: row.task })),
      ),
    );
  const listByThreadId: ProjectionThreadTaskRepositoryShape["listByThreadId"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(mapError("ProjectionThreadTaskRepository.listByThreadId", "decode")),
      Effect.map((rows) =>
        rows.map((row) => ({ taskId: row.taskId, threadId: row.threadId, task: row.task })),
      ),
    );
  const remove: ProjectionThreadTaskRepositoryShape["remove"] = (input) =>
    removeRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadTaskRepository.remove")),
    );
  const deleteByThreadId: ProjectionThreadTaskRepositoryShape["deleteByThreadId"] = (input) =>
    deleteRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadTaskRepository.deleteByThreadId")),
    );
  return {
    upsert,
    getByTaskId,
    listByThreadId,
    remove,
    deleteByThreadId,
  } satisfies ProjectionThreadTaskRepositoryShape;
});

export const ProjectionThreadTaskRepositoryLive = Layer.effect(
  ProjectionThreadTaskRepository,
  makeRepository,
);
