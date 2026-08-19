import { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import { assertProjectionThreadParent } from "./ProjectionThreadOwnership.ts";
import {
  DeleteProjectionPendingUserInputsByProjectInput,
  DeleteProjectionPendingUserInputsByThreadInput,
  GetProjectionPendingUserInputInput,
  ProjectionPendingUserInput,
  ProjectionPendingUserInputRepository,
  type ProjectionPendingUserInputRepositoryShape,
} from "../Services/ProjectionPendingUserInputs.ts";

const ProjectionPendingUserInputDbRow = ProjectionPendingUserInput.mapFields(
  Struct.assign({ questions: Schema.fromJsonString(Schema.Array(UserInputQuestion)) }),
);

const makeProjectionPendingUserInputRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const upsertRow = SqlSchema.void({
    Request: ProjectionPendingUserInput,
    execute: (row) => sql`
      INSERT INTO projection_pending_user_inputs (
        request_id, thread_id, turn_id, status, questions_json, created_at, resolved_at
      ) VALUES (
        ${row.requestId}, ${row.threadId}, ${row.turnId}, ${row.status},
        ${JSON.stringify(row.questions)}, ${row.createdAt}, ${row.resolvedAt}
      )
      ON CONFLICT (request_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        status = excluded.status,
        questions_json = excluded.questions_json,
        created_at = excluded.created_at,
        resolved_at = excluded.resolved_at
    `,
  });
  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionPendingUserInputInput,
    Result: ProjectionPendingUserInputDbRow,
    execute: ({ requestId }) => sql`
      SELECT
        request_id AS "requestId", thread_id AS "threadId", turn_id AS "turnId",
        status, questions_json AS questions, created_at AS "createdAt", resolved_at AS "resolvedAt"
      FROM projection_pending_user_inputs
      WHERE request_id = ${requestId}
    `,
  });
  const deleteThreadRows = SqlSchema.void({
    Request: DeleteProjectionPendingUserInputsByThreadInput,
    execute: ({ threadId }) =>
      sql`DELETE FROM projection_pending_user_inputs WHERE thread_id = ${threadId}`,
  });
  const deleteProjectRows = SqlSchema.void({
    Request: DeleteProjectionPendingUserInputsByProjectInput,
    execute: ({ projectId }) => sql`
      DELETE FROM projection_pending_user_inputs
      WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = ${projectId})
    `,
  });

  const upsert: ProjectionPendingUserInputRepositoryShape["upsert"] = (row) =>
    Effect.gen(function* () {
      yield* assertProjectionThreadParent(sql, row.threadId);
      yield* upsertRow(row);
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPendingUserInputRepository.upsert:query")),
    );
  const getByRequestId: ProjectionPendingUserInputRepositoryShape["getByRequestId"] = (input) =>
    getRow(input).pipe(
      Effect.map(Option.map((row) => row as ProjectionPendingUserInput)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingUserInputRepository.getByRequestId:query"),
      ),
    );
  const deleteByThreadId: ProjectionPendingUserInputRepositoryShape["deleteByThreadId"] = (input) =>
    deleteThreadRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingUserInputRepository.deleteByThreadId:query"),
      ),
    );
  const deleteByProjectId: ProjectionPendingUserInputRepositoryShape["deleteByProjectId"] = (
    input,
  ) =>
    deleteProjectRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingUserInputRepository.deleteByProjectId:query"),
      ),
    );

  return {
    upsert,
    getByRequestId,
    deleteByThreadId,
    deleteByProjectId,
  } satisfies ProjectionPendingUserInputRepositoryShape;
});

export const ProjectionPendingUserInputRepositoryLive = Layer.effect(
  ProjectionPendingUserInputRepository,
  makeProjectionPendingUserInputRepository,
);
