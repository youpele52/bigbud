import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import type {
  MetadataGenerationJob,
  ThreadMetadataGenerationRepositoryShape,
} from "../Services/ThreadMetadataGeneration.ts";
import { withMetadataTransaction } from "./ThreadMetadataGeneration.transaction.ts";

/** A replacement belongs to the original request, not a fresh paid-work budget. */
export function makeMetadataCaptureIdentity(sql: SqlClient.SqlClient) {
  const retireUndispatched: ThreadMetadataGenerationRepositoryShape["retireUndispatched"] = (
    job,
    at,
  ) =>
    withMetadataTransaction(
      sql,
      Effect.gen(function* () {
        // The job CAS also excludes a concurrent prepare/dispatch. Never release a
        // dispatched, unknown, or retained-result reservation, including native work.
        const retired = yield* sql`UPDATE thread_metadata_generation_jobs
          SET state = 'stale', next_attempt_at = ${at}, revision = revision + 1
          WHERE job_id = ${job.jobId} AND revision = ${job.revision}
            AND state IN ('pending', 'waiting-model', 'waiting-native', 'running')
            AND NOT EXISTS (SELECT 1 FROM thread_metadata_generation_attempts a
              WHERE a.job_id = ${job.jobId} AND (a.dispatched_at IS NOT NULL
                OR a.state NOT IN ('prepared', 'stale', 'cancelled', 'unavailable')))
          RETURNING job_id`;
        if (retired.length !== 1) return false;
        yield* sql`UPDATE thread_metadata_generation_attempts
          SET state = 'stale', updated_at = ${at}, revision = revision + 1
          WHERE job_id = ${job.jobId} AND state = 'prepared'`;
        return true;
      }),
    ).pipe(Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.retireUndispatched")));

  const replacement = (job: Omit<MetadataGenerationJob, "revision" | "state">) =>
    Effect.gen(function* () {
      const prefix = `${job.generationKey}:capture:`;
      // The unique (thread, operation, generation) index bounds this request family.
      const upper = `${prefix}￿`;
      const family = yield* sql<
        Pick<
          MetadataGenerationJob,
          "jobId" | "generationKey" | "state" | "deadlineAt" | "modelWaitUntil" | "nativeWaitUntil"
        > & { spent: number }
      >`SELECT
          j.job_id AS "jobId", j.generation_key AS "generationKey", j.state,
          j.deadline_at AS "deadlineAt", j.model_wait_until AS "modelWaitUntil",
          j.native_wait_until AS "nativeWaitUntil",
          EXISTS (SELECT 1 FROM thread_metadata_generation_attempts a
            WHERE a.job_id = j.job_id AND (a.dispatched_at IS NOT NULL
              OR a.state NOT IN ('prepared', 'stale', 'cancelled', 'unavailable'))) AS spent
        FROM thread_metadata_generation_jobs j
        WHERE j.thread_id = ${job.threadId} AND j.operation = ${job.operation}
          AND (j.generation_key = ${job.generationKey}
            OR (j.generation_key >= ${prefix} AND j.generation_key < ${upper}))`;
      const original = family.find((entry) => entry.generationKey === job.generationKey);
      if (!original) return { input: job, retainedId: null };
      if (Date.parse(job.createdAt) >= Date.parse(original.deadlineAt))
        return { input: job, retainedId: original.jobId };
      // Automatic invalidation recovery is permitted only before ANY paid work.
      // Explicit retries have their own stable request key. Never turn a settled
      // paid capture into a fresh budget just because its workspace/source changed.
      const retained = family.find((entry) => entry.spent || entry.state !== "stale");
      if (retained) return { input: job, retainedId: retained.jobId };
      // A→B→A can revisit an identical immutable capture. Keep its stale job and
      // prepared attempts fenced permanently rather than reviving old owners.
      // Family resolution and insertion share createOrGet's SQL transaction.
      const jobId = family.some((entry) => entry.jobId === job.jobId)
        ? `${job.jobId}:capture:${family.length}`
        : job.jobId;
      return {
        input: {
          ...job,
          jobId,
          generationKey: `${prefix}${jobId}`,
          deadlineAt: original.deadlineAt,
          modelWaitUntil: original.modelWaitUntil,
          nativeWaitUntil: original.nativeWaitUntil,
        },
        retainedId: null,
      };
    });
  return { retireUndispatched, replacement };
}
