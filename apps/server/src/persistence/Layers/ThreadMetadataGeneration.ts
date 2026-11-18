import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ThreadMetadataGenerationRepository,
  type MetadataGenerationJob,
  type ThreadMetadataGenerationRepositoryShape,
} from "../Services/ThreadMetadataGeneration.ts";
import { withMetadataTransaction } from "./ThreadMetadataGeneration.transaction.ts";
import { makeMetadataAttempts } from "./ThreadMetadataGeneration.attempts.ts";
import { makeMetadataWarnings } from "./ThreadMetadataGeneration.warnings.ts";
import { makeMetadataCaptureIdentity } from "./ThreadMetadataGeneration.captureIdentity.ts";
import { makeMetadataModelBindings } from "./ThreadMetadataGeneration.modelBinding.ts";
import { makeMetadataStateReader } from "./ThreadMetadataGeneration.state.ts";

export const makeThreadMetadataGenerationRepository = Effect.fn(
  "makeThreadMetadataGenerationRepository",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const attempts = yield* makeMetadataAttempts();
  const warnings = yield* makeMetadataWarnings();
  const modelBindings = yield* makeMetadataModelBindings();
  const captureIdentity = makeMetadataCaptureIdentity(sql);
  const columns = sql`job_id AS "jobId", thread_id AS "threadId", operation,
    generation_key AS "generationKey", config_epoch AS "configEpoch", state,
    context_json AS "contextJson", expected_revision AS "expectedRevision",
    source_frontier AS "sourceFrontier", workspace_fingerprint AS "workspaceFingerprint",
    created_at AS "createdAt", deadline_at AS "deadlineAt", model_wait_until AS "modelWaitUntil",
    native_wait_until AS "nativeWaitUntil", next_attempt_at AS "nextAttemptAt", revision`;
  const fail = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`ThreadMetadataGeneration.${operation}`));
  const get: ThreadMetadataGenerationRepositoryShape["get"] = (jobId) =>
    sql<MetadataGenerationJob>`SELECT ${columns} FROM thread_metadata_generation_jobs
      WHERE job_id = ${jobId}`.pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
      fail("get"),
    );
  const findOpen: ThreadMetadataGenerationRepositoryShape["findOpen"] = (threadId, operation) =>
    sql<MetadataGenerationJob>`SELECT ${columns} FROM thread_metadata_generation_jobs
      WHERE thread_id = ${threadId} AND operation = ${operation}
        AND state IN ('pending', 'waiting-model', 'waiting-native', 'running', 'uncertain', 'result-ready')`.pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
      fail("findOpen"),
    );
  const createOrGet: ThreadMetadataGenerationRepositoryShape["createOrGet"] = (requested) =>
    withMetadataTransaction(
      sql,
      Effect.gen(function* () {
        const resolved = yield* captureIdentity.replacement(requested);
        if (resolved.retainedId) {
          const retained = yield* get(resolved.retainedId);
          if (Option.isSome(retained)) return retained.value;
        }
        const j = resolved.input;
        yield* sql`INSERT INTO thread_metadata_generation_jobs (
          job_id, thread_id, operation, generation_key, config_epoch, state, context_json,
          expected_revision, source_frontier, workspace_fingerprint, created_at, deadline_at,
          model_wait_until, native_wait_until, next_attempt_at
        ) VALUES (${j.jobId}, ${j.threadId}, ${j.operation}, ${j.generationKey}, ${j.configEpoch},
          'pending', ${j.contextJson}, ${j.expectedRevision}, ${j.sourceFrontier},
          ${j.workspaceFingerprint}, ${j.createdAt}, ${j.deadlineAt}, ${j.modelWaitUntil},
          ${j.nativeWaitUntil}, ${j.nextAttemptAt}) ON CONFLICT DO NOTHING`;
        const rows = yield* sql<MetadataGenerationJob>`SELECT ${columns}
          FROM thread_metadata_generation_jobs WHERE thread_id = ${j.threadId}
            AND operation = ${j.operation} AND (generation_key = ${j.generationKey}
              OR state IN ('pending', 'waiting-model', 'waiting-native', 'running', 'uncertain', 'result-ready'))
          ORDER BY CASE WHEN state IN ('pending', 'waiting-model', 'waiting-native', 'running', 'uncertain', 'result-ready')
            THEN 0 ELSE 1 END LIMIT 1`;
        const job = rows[0];
        if (!job)
          return yield* Effect.die(
            "Metadata job identity conflicts with a different thread or operation",
          );
        return job;
      }),
    ).pipe(fail("createOrGet"));
  const listDue: ThreadMetadataGenerationRepositoryShape["listDue"] = (input) =>
    sql<MetadataGenerationJob>`SELECT ${columns} FROM thread_metadata_generation_jobs
      WHERE state IN ('pending', 'waiting-model', 'waiting-native', 'running', 'uncertain', 'result-ready')
        AND next_attempt_at <= ${input.at} AND job_id > ${input.afterJobId ?? ""}
      ORDER BY job_id LIMIT ${Math.max(1, Math.min(100, input.limit))}`.pipe(fail("listDue"));
  const transitionJob: ThreadMetadataGenerationRepositoryShape["transitionJob"] = (input) =>
    withMetadataTransaction(
      sql,
      Effect.gen(function* () {
        const rows = yield* sql<{ jobId: string }>`UPDATE thread_metadata_generation_jobs
      SET state = ${input.state}, next_attempt_at = ${input.nextAttemptAt}, revision = revision + 1
      WHERE job_id = ${input.jobId} AND revision = ${input.expectedRevision}
        AND state IN ('pending', 'waiting-model', 'waiting-native', 'running', 'uncertain', 'result-ready')
        AND (${input.state} IN ('running', 'uncertain', 'result-ready') OR NOT EXISTS (
          SELECT 1 FROM thread_metadata_generation_attempts a
          WHERE a.job_id = thread_metadata_generation_jobs.job_id
            AND a.state IN ('prepared', 'dispatch-intent', 'acknowledged', 'uncertain', 'result-ready')
        ))
      RETURNING job_id AS "jobId"`;
        if (rows.length === 1 && (input.state === "exhausted" || input.state === "unavailable")) {
          // Persist delivery intent with terminal settlement: terminal jobs are not scanned again.
          yield* warnings.enqueueFinalWarning({ jobId: input.jobId, at: input.nextAttemptAt });
        }
        return rows.length === 1;
      }),
    ).pipe(fail("transitionJob"));
  const readMetadataState = yield* makeMetadataStateReader();
  const advanceMetadataRevision: ThreadMetadataGenerationRepositoryShape["advanceMetadataRevision"] =
    (threadId, operation) => {
      const title = operation === "title" ? 1 : 0;
      const summary = operation === "summary" ? 1 : 0;
      return sql`INSERT INTO thread_metadata_generation_state (thread_id, title_revision, summary_revision)
      VALUES (${threadId}, ${title}, ${summary}) ON CONFLICT(thread_id) DO UPDATE SET
        title_revision = title_revision + ${title}, summary_revision = summary_revision + ${summary}`.pipe(
        Effect.asVoid,
        fail("advanceMetadataRevision"),
      );
    };
  const recordSuccessfulModel: ThreadMetadataGenerationRepositoryShape["recordSuccessfulModel"] = (
    threadId,
    modelJson,
  ) =>
    sql`INSERT INTO thread_metadata_generation_state (thread_id, successful_model_json)
      VALUES (${threadId}, ${modelJson}) ON CONFLICT(thread_id) DO UPDATE SET successful_model_json = ${modelJson}`.pipe(
      Effect.asVoid,
      fail("recordSuccessfulModel"),
    );
  return {
    get,
    findOpen,
    createOrGet,
    retireUndispatched: captureIdentity.retireUndispatched,
    listDue,
    transitionJob,
    readMetadataState,
    advanceMetadataRevision,
    recordSuccessfulModel,
    ...attempts,
    ...warnings,
    ...modelBindings,
  } satisfies ThreadMetadataGenerationRepositoryShape;
});

export const ThreadMetadataGenerationRepositoryLive = Layer.effect(
  ThreadMetadataGenerationRepository,
  makeThreadMetadataGenerationRepository(),
);
