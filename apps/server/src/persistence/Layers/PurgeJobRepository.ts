import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import { purgeManifestDigest } from "../PurgeManifest.ts";
import {
  BindPurgeManifestInput,
  ClaimPurgeExecutionInput,
  ClaimPurgeResourcesInput,
  CompletePurgeJobInput,
  CreatePurgeJobInput,
  FindIncompletePurgeJobInput,
  PurgeJob,
  PURGE_MAX_ATTEMPTS,
  PurgeJobRepository,
  TransitionPurgeJobInput,
  type PurgeJobRepositoryShape,
  UpdatePurgeJobInput,
} from "../Services/PurgeJobRepository.ts";

const ListIncompleteInput = Schema.Struct({ dueAt: Schema.String, limit: Schema.Number });

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
        resource_manifest_digest,
        manifest_sealed_at,
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
        'awaiting-finalization',
        'pending',
        ${JSON.stringify(input.resourceManifest)},
        ${purgeManifestDigest(input.resourceManifest)},
        NULL,
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
        resource_manifest_digest AS "manifestDigest",
        manifest_sealed_at AS "manifestSealedAt",
        attempt_count AS "attemptCount",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM purge_jobs
      WHERE entity_kind = ${input.entityKind}
        AND entity_id = ${input.entityId}
        AND status <> 'completed' AND auto_resume_disabled = 0
        AND last_error IS NOT 'manual_recovery_required'
      LIMIT 1
    `,
  });

  const findJobById = (jobId: string) =>
    sql<PurgeJob>`
      SELECT job_id AS "jobId", entity_kind AS "entityKind", entity_id AS "entityId",
        phase, status, resource_manifest_json AS "resourceManifest",
        resource_manifest_digest AS "manifestDigest", manifest_sealed_at AS "manifestSealedAt",
        attempt_count AS "attemptCount", last_error AS "lastError",
        created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"
      FROM purge_jobs WHERE job_id = ${jobId} LIMIT 1
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const listIncompleteJobs = SqlSchema.findAll({
    Request: ListIncompleteInput,
    Result: PurgeJob,
    execute: ({ dueAt, limit }) => sql`
      SELECT
        job_id AS "jobId",
        entity_kind AS "entityKind",
        entity_id AS "entityId",
        phase,
        status,
        resource_manifest_json AS "resourceManifest",
        resource_manifest_digest AS "manifestDigest",
        manifest_sealed_at AS "manifestSealedAt",
        attempt_count AS "attemptCount",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM purge_jobs
      WHERE status <> 'completed' AND auto_resume_disabled = 0
        AND last_error IS NOT 'manual_recovery_required'
        AND updated_at <= ${dueAt}
        AND (attempt_count < ${PURGE_MAX_ATTEMPTS} OR EXISTS (
          SELECT 1 FROM orchestration_deletion_markers AS marker
          JOIN projection_baselines AS baseline
            ON baseline.sequence = marker.covered_by_baseline_sequence
            AND baseline.verification_status = 'verified'
          WHERE marker.entity_kind = purge_jobs.entity_kind
            AND marker.entity_id = purge_jobs.entity_id
            AND marker.deletion_sequence <= marker.covered_by_baseline_sequence
            AND COALESCE((SELECT MAX(sequence) FROM orchestration_events
              WHERE aggregate_kind = purge_jobs.entity_kind
                AND stream_id = purge_jobs.entity_id), 0) <= marker.covered_by_baseline_sequence
            AND COALESCE((SELECT MAX(result_sequence) FROM orchestration_command_receipts
              WHERE aggregate_kind = purge_jobs.entity_kind
                AND aggregate_id = purge_jobs.entity_id), 0) <= marker.covered_by_baseline_sequence
        ))
      ORDER BY CASE WHEN status = 'failed' THEN 0 ELSE 1 END,
        updated_at ASC, job_id ASC
      LIMIT ${limit}
    `,
  });

  const bindManifestRow = SqlSchema.findAll({
    Request: BindPurgeManifestInput,
    Result: Schema.Struct({ jobId: Schema.String }),
    execute: (input) => sql`
      UPDATE purge_jobs
      SET resource_manifest_json = ${JSON.stringify(input.resourceManifest)},
        resource_manifest_digest = ${purgeManifestDigest(input.resourceManifest)},
        updated_at = ${input.updatedAt}
      WHERE job_id = ${input.jobId} AND status <> 'completed' AND auto_resume_disabled = 0
        AND last_error IS NOT 'manual_recovery_required'
        AND phase IN ('awaiting-finalization', 'baseline')
        AND resource_manifest_json = ${input.expectedManifestJson}
        AND updated_at = ${input.expectedUpdatedAt}
      RETURNING job_id AS "jobId"
    `,
  });

  const claimResources = (input: typeof ClaimPurgeResourcesInput.Type) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        input.resourceManifest,
        (resource) => {
          if (resource.identity === null) {
            return Effect.void;
          }
          const attachmentId =
            resource.kind === "attachment"
              ? resource.relativePath.slice(0, resource.relativePath.lastIndexOf("."))
              : null;
          return sql`
          INSERT INTO purge_resource_claims (
            job_id, entity_kind, entity_id, resource_kind, relative_path, attachment_id,
            declared_path, canonical_path, device, inode, resource_type, claimed_at
          ) VALUES (
            ${input.jobId}, ${input.entityKind}, ${input.entityId}, ${resource.kind},
            ${resource.relativePath}, ${attachmentId}, ${resource.identity.declaredPath},
            ${resource.identity.canonicalPath},
            ${resource.identity.device}, ${resource.identity.inode}, ${resource.identity.type},
            ${input.claimedAt}
          )
          ON CONFLICT (job_id, resource_kind, relative_path) DO UPDATE SET
            claimed_at = excluded.claimed_at
          WHERE purge_resource_claims.canonical_path = excluded.canonical_path
            AND purge_resource_claims.device = excluded.device
            AND purge_resource_claims.inode = excluded.inode
            AND purge_resource_claims.resource_type = excluded.resource_type
        `.pipe(Effect.asVoid);
        },
        { concurrency: 1, discard: true },
      );
      const manifestJson = JSON.stringify(input.resourceManifest);
      const digest = purgeManifestDigest(input.resourceManifest);
      const sealed = yield* sql<{ readonly jobId: string }>`
        UPDATE purge_jobs SET resource_manifest_digest = ${digest},
          manifest_sealed_at = COALESCE(manifest_sealed_at, ${input.claimedAt})
        WHERE job_id = ${input.jobId} AND resource_manifest_json = ${manifestJson}
          AND (resource_manifest_digest IS NULL OR resource_manifest_digest = ${digest})
        RETURNING job_id AS "jobId"
      `;
      if (sealed.length !== 1) {
        return yield* Effect.fail(new Error("purge manifest could not be sealed"));
      }
    });

  const updateJob = SqlSchema.findAll({
    Request: UpdatePurgeJobInput,
    Result: Schema.Struct({ jobId: Schema.String }),
    execute: (input) => sql`
      UPDATE purge_jobs
      SET
        phase = ${input.phase},
        status = ${input.status},
        last_error = CASE
          WHEN ${input.status} = 'failed'
            AND ${input.phase} = 'awaiting-finalization'
            AND ${input.lastError} = 'entity deletion marker is not yet available'
            AND attempt_count + 1 >= ${PURGE_MAX_ATTEMPTS}
          THEN 'manual_recovery_required' ELSE ${input.lastError}
        END,
        attempt_count = attempt_count + CASE WHEN ${input.status} = 'failed' THEN 1 ELSE 0 END,
        auto_resume_disabled = CASE
          WHEN ${input.status} = 'failed'
            AND ${input.phase} = 'awaiting-finalization'
            AND ${input.lastError} = 'entity deletion marker is not yet available'
            AND attempt_count + 1 >= ${PURGE_MAX_ATTEMPTS}
          THEN 1 ELSE auto_resume_disabled
        END,
        updated_at = ${input.updatedAt}
      WHERE job_id = ${input.jobId}
        AND phase = ${input.phase}
        AND status <> 'completed' AND auto_resume_disabled = 0
        AND last_error IS NOT 'manual_recovery_required'
      RETURNING job_id AS "jobId"
    `,
  });

  const transitionJob = SqlSchema.findAll({
    Request: TransitionPurgeJobInput,
    Result: Schema.Struct({ jobId: Schema.String }),
    execute: (input) => sql`
      UPDATE purge_jobs
      SET phase = ${input.nextPhase}, status = 'running', last_error = NULL,
        updated_at = ${input.updatedAt}
      WHERE job_id = ${input.jobId}
        AND phase = ${input.expectedPhase}
        AND status <> 'completed' AND auto_resume_disabled = 0
        AND last_error IS NOT 'manual_recovery_required'
      RETURNING job_id AS "jobId"
    `,
  });

  const completeJob = SqlSchema.findAll({
    Request: CompletePurgeJobInput,
    Result: Schema.Struct({ jobId: Schema.String }),
    execute: (input) => sql`
      UPDATE purge_jobs
      SET
        status = 'completed',
        last_error = NULL,
        completed_at = ${input.completedAt},
        updated_at = ${input.completedAt}
        WHERE job_id = ${input.jobId} AND phase = 'root'
          AND status <> 'completed' AND auto_resume_disabled = 0
          AND last_error IS NOT 'manual_recovery_required'
        AND manifest_sealed_at IS NOT NULL AND resource_manifest_digest IS NOT NULL
      RETURNING job_id AS "jobId"
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
    findById: (jobId) =>
      findJobById(jobId).pipe(
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.findById:query")),
      ),
    listIncomplete: (limit, dueAt = new Date().toISOString()) =>
      listIncompleteJobs({
        dueAt,
        limit: Math.max(1, Math.min(100, Math.floor(limit))),
      }).pipe(Effect.mapError(toPersistenceSqlError("PurgeJobRepository.listIncomplete:query"))),
    countIncomplete: () =>
      sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM purge_jobs
        WHERE status <> 'completed' AND auto_resume_disabled = 0
          AND last_error IS NOT 'manual_recovery_required'
          AND attempt_count < ${PURGE_MAX_ATTEMPTS}
      `.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.countIncomplete:query")),
      ),
    claimExecution: (input: typeof ClaimPurgeExecutionInput.Type) =>
      sql`
        UPDATE purge_jobs SET execution_lease_id = ${input.leaseId},
          execution_lease_expires_at = ${input.expiresAt}
        WHERE job_id = ${input.jobId} AND status <> 'completed' AND auto_resume_disabled = 0
          AND last_error IS NOT 'manual_recovery_required'
          AND (execution_lease_id IS NULL OR execution_lease_expires_at <= ${input.claimedAt})
        RETURNING job_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.claimExecution:query")),
      ),
    releaseExecution: (jobId, leaseId) =>
      sql`
        UPDATE purge_jobs SET execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE job_id = ${jobId} AND execution_lease_id = ${leaseId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.releaseExecution:query")),
      ),
    bindManifest: (input) =>
      bindManifestRow(input).pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.bindManifest:query")),
      ),
    claimResources: (input) =>
      claimResources(input).pipe(
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.claimResources:query")),
      ),
    releaseClaims: (jobId) =>
      sql`DELETE FROM purge_resource_claims WHERE job_id = ${jobId}`.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.releaseClaims:query")),
      ),
    update: (input) =>
      updateJob(input).pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.update:query")),
      ),
    transition: (input) =>
      transitionJob(input).pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("PurgeJobRepository.transition:query")),
      ),
    complete: (input) =>
      sql
        .withTransaction(
          completeJob(input).pipe(
            Effect.flatMap((rows) =>
              rows.length === 1
                ? sql`DELETE FROM purge_resource_claims WHERE job_id = ${input.jobId}`.pipe(
                    Effect.as(true),
                  )
                : Effect.succeed(false),
            ),
          ),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("PurgeJobRepository.complete:query"))),
  } satisfies PurgeJobRepositoryShape;
});

export const PurgeJobRepositoryLive = Layer.effect(PurgeJobRepository, makePurgeJobRepository);
