import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CompletePurgeJobInput,
  CreatePurgeJobInput,
  FindIncompletePurgeJobInput,
  PurgeJob,
  PurgeJobRepository,
  type PurgeJobRepositoryShape,
  UpdatePurgeJobInput,
} from "../Services/PurgeJobRepository.ts";

const ListIncompleteInput = Schema.Struct({ limit: Schema.Number });

const makePurgeJobRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertJob = SqlSchema.void({
    Request: CreatePurgeJobInput,
    execute: (input) => sql`
      INSERT INTO purge_jobs (
        job_id,
        entity_kind,
        entity_id,
        phase,
        status,
        resource_manifest_json,
        attempt_count,
        last_error,
        created_at,
        updated_at,
        completed_at
      )
      VALUES (
        ${input.jobId},
        ${input.entityKind},
        ${input.entityId},
        'marking',
        'pending',
        ${JSON.stringify(input.resourceManifest)},
        0,
        NULL,
        ${input.createdAt},
        ${input.createdAt},
        NULL
      )
      ON CONFLICT DO NOTHING
    `,
  });

  const findIncompleteJob = SqlSchema.findOneOption({
    Request: FindIncompletePurgeJobInput,
    Result: PurgeJob,
    execute: (input) => sql`
      SELECT
        job_id AS "jobId",
        entity_kind AS "entityKind",
        entity_id AS "entityId",
        phase,
        status,
        resource_manifest_json AS "resourceManifest",
        attempt_count AS "attemptCount",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM purge_jobs
      WHERE entity_kind = ${input.entityKind}
        AND entity_id = ${input.entityId}
        AND status <> 'completed'
      LIMIT 1
    `,
  });

  const listIncompleteJobs = SqlSchema.findAll({
    Request: ListIncompleteInput,
    Result: PurgeJob,
    execute: ({ limit }) => sql`
      SELECT
        job_id AS "jobId",
        entity_kind AS "entityKind",
        entity_id AS "entityId",
        phase,
        status,
        resource_manifest_json AS "resourceManifest",
        attempt_count AS "attemptCount",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM purge_jobs
      WHERE status <> 'completed'
      ORDER BY updated_at ASC, job_id ASC
      LIMIT ${limit}
    `,
  });

  const updateJob = SqlSchema.void({
    Request: UpdatePurgeJobInput,
    execute: (input) => sql`
      UPDATE purge_jobs
      SET
        phase = ${input.phase},
        status = ${input.status},
        last_error = ${input.lastError},
        attempt_count = attempt_count + 1,
        updated_at = ${input.updatedAt}
      WHERE job_id = ${input.jobId}
        AND status <> 'completed'
    `,
  });

  const completeJob = SqlSchema.void({
    Request: CompletePurgeJobInput,
    execute: (input) => sql`
      UPDATE purge_jobs
      SET
        status = 'completed',
        last_error = NULL,
        completed_at = ${input.completedAt},
        updated_at = ${input.completedAt}
      WHERE job_id = ${input.jobId}
    `,
  });

  const findIncomplete: PurgeJobRepositoryShape["findIncomplete"] = (input) =>
    findIncompleteJob(input).pipe(
      Effect.mapError(toPersistenceSqlError("PurgeJobRepository.findIncomplete:query")),
    );

  const createOrGet: PurgeJobRepositoryShape["createOrGet"] = (input) =>
    sql
      .withTransaction(
        insertJob(input).pipe(
          Effect.flatMap(() => findIncompleteJob(input)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.die("purge job insert did not produce an incomplete job"),
              onSome: Effect.succeed,
            }),
          ),
        ),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("PurgeJobRepository.createOrGet:query")));

  return {
    createOrGet,
    findIncomplete,
    listIncomplete: (limit) =>
      listIncompleteJobs({ limit: Math.max(1, Math.min(100, Math.floor(limit))) }).pipe(
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.listIncomplete:query")),
      ),
    update: (input) =>
      updateJob(input).pipe(
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.update:query")),
      ),
    complete: (input) =>
      completeJob(input).pipe(
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.complete:query")),
      ),
  } satisfies PurgeJobRepositoryShape;
});

export const PurgeJobRepositoryLive = Layer.effect(PurgeJobRepository, makePurgeJobRepository);
