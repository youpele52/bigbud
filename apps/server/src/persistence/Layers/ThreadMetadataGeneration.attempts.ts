import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { withMetadataTransaction } from "./ThreadMetadataGeneration.transaction.ts";
import type {
  MetadataGenerationAttempt,
  ThreadMetadataGenerationRepositoryShape,
} from "../Services/ThreadMetadataGeneration.ts";

export const makeMetadataAttempts = Effect.fn("makeMetadataAttempts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`attempt_id AS "attemptId", job_id AS "jobId", thread_id AS "threadId",
    stage, ordinal, owner, execution_fingerprint AS "executionFingerprint", state,
    payload_json AS "payloadJson", result, provider_session_id AS "providerSessionId",
    provider_turn_id AS "providerTurnId", session_epoch AS "sessionEpoch",
    created_at AS "createdAt", dispatched_at AS "dispatchedAt", updated_at AS "updatedAt", revision`;
  const fail = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`ThreadMetadataGeneration.${operation}`));

  const listAttempts: ThreadMetadataGenerationRepositoryShape["listAttempts"] = (jobId) =>
    sql<MetadataGenerationAttempt>`SELECT ${columns} FROM thread_metadata_generation_attempts
      WHERE job_id = ${jobId} ORDER BY created_at, stage, ordinal`.pipe(fail("listAttempts"));

  const prepareAttempt: ThreadMetadataGenerationRepositoryShape["prepareAttempt"] = ({
    job,
    attempt: a,
  }) =>
    withMetadataTransaction(
      sql,
      Effect.gen(function* () {
        // Never turn an unknown dispatch into a new attempt, even after the job deadline.
        yield* sql`INSERT INTO thread_metadata_generation_attempts (
          attempt_id, job_id, thread_id, stage, ordinal, owner, execution_fingerprint, state,
          payload_json, provider_session_id, provider_turn_id, session_epoch, created_at, updated_at
        ) SELECT ${a.attemptId}, ${job.jobId}, ${job.threadId}, ${a.stage}, ${a.ordinal},
          ${a.owner}, ${a.executionFingerprint}, 'prepared', ${a.payloadJson},
          ${a.providerSessionId}, ${a.providerTurnId}, ${a.sessionEpoch}, ${a.createdAt}, ${a.updatedAt}
        FROM thread_metadata_generation_jobs j
        WHERE j.job_id = ${job.jobId} AND j.revision = ${job.revision}
          AND ${a.stage} != 'native'
          AND (${a.stage} != 'primary' OR ${a.ordinal} <= 2)
          AND (${a.stage} != 'thread-model' OR ${a.ordinal} = 1)
          AND j.state IN ('pending', 'waiting-model', 'waiting-native', 'running')
          AND j.deadline_at > ${a.createdAt} AND j.next_attempt_at <= ${a.createdAt}
          AND ${a.ordinal} = 1 + (SELECT COUNT(*) FROM thread_metadata_generation_attempts x
            WHERE x.job_id = j.job_id AND x.stage = ${a.stage})
          AND NOT EXISTS (
            SELECT 1 FROM thread_metadata_generation_attempts x WHERE x.job_id = j.job_id
              AND x.state IN ('prepared', 'dispatch-intent', 'acknowledged', 'uncertain', 'result-ready')
          )
        ON CONFLICT DO NOTHING`;
        const rows = yield* sql<MetadataGenerationAttempt>`SELECT ${columns}
          FROM thread_metadata_generation_attempts
          WHERE job_id = ${job.jobId} AND stage = ${a.stage} AND ordinal = ${a.ordinal}`;
        return Option.fromUndefinedOr(rows[0]);
      }),
    ).pipe(fail("prepareAttempt"));

  const claimDispatch: ThreadMetadataGenerationRepositoryShape["claimDispatch"] = (a, at) =>
    withMetadataTransaction(
      sql,
      Effect.gen(function* () {
        const claimed = yield* sql<{
          attemptId: string;
        }>`UPDATE thread_metadata_generation_attempts
        SET state = 'dispatch-intent', dispatched_at = ${at}, updated_at = ${at}, revision = revision + 1
        WHERE attempt_id = ${a.attemptId} AND owner = ${a.owner} AND revision = ${a.revision}
          AND state = 'prepared' AND payload_json = ${a.payloadJson} AND job_id = ${a.jobId}
          AND thread_id = ${a.threadId} AND stage = ${a.stage}
          AND stage != 'native'
          AND (stage != 'primary' OR ordinal <= 2)
          AND EXISTS (SELECT 1 FROM thread_metadata_generation_jobs j
            WHERE j.job_id = thread_metadata_generation_attempts.job_id
              AND j.state IN ('pending', 'waiting-model', 'waiting-native', 'running')
              AND j.deadline_at > ${at} AND j.next_attempt_at <= ${at})
        RETURNING attempt_id AS "attemptId"`;
        if (claimed.length !== 1) return false;
        // Failed refreshes resume at +10 messages, not on every event and not never again.
        yield* sql`INSERT INTO thread_metadata_generation_state (thread_id, summary_attempted_frontier)
        SELECT thread_id, source_frontier FROM thread_metadata_generation_jobs
          WHERE job_id = ${a.jobId} AND operation = 'summary'
        ON CONFLICT(thread_id) DO UPDATE SET summary_attempted_frontier =
          MAX(summary_attempted_frontier, excluded.summary_attempted_frontier)`;
        return true;
      }),
    ).pipe(fail("claimDispatch"));

  const settleAttempt: ThreadMetadataGenerationRepositoryShape["settleAttempt"] = (input) => {
    const { attempt: a, state } = input;
    const allowed =
      (a.state === "prepared" &&
        (state === "cancelled" || state === "unavailable" || state === "stale")) ||
      ((a.state === "dispatch-intent" || a.state === "acknowledged" || a.state === "uncertain") &&
        (state === "acknowledged" ||
          state === "uncertain" ||
          state === "result-ready" ||
          state === "failed" ||
          state === "stale" ||
          state === "cancelled")) ||
      (a.state === "result-ready" && (state === "completed" || state === "stale"));
    if (!allowed || (state === "result-ready" && !input.result?.trim()))
      return Effect.succeed(false);
    // Stamp provenance from the durable pre-update row, never from caller-supplied history.
    // Revision zero proves no intermediate dispatch/acknowledgment/result transition occurred.
    return sql<{ attemptId: string }>`UPDATE thread_metadata_generation_attempts
      SET cancelled_before_dispatch_at_deadline = CASE
          WHEN state = 'prepared' AND ${state} = 'cancelled' AND stage != 'native'
            AND revision = 0 AND dispatched_at IS NULL AND result IS NULL
            AND provider_session_id IS NULL AND provider_turn_id IS NULL AND session_epoch IS NULL
            AND ${input.result ?? null} IS NULL AND ${input.providerSessionId ?? null} IS NULL
            AND ${input.providerTurnId ?? null} IS NULL AND ${input.sessionEpoch ?? null} IS NULL
            AND EXISTS (SELECT 1 FROM thread_metadata_generation_jobs j
              WHERE j.job_id = thread_metadata_generation_attempts.job_id AND j.deadline_at <= ${input.at})
          THEN 1 ELSE 0 END,
        state = ${state}, result = COALESCE(result, ${input.result ?? null}),
        provider_session_id = COALESCE(provider_session_id, ${input.providerSessionId ?? null}),
        provider_turn_id = COALESCE(provider_turn_id, ${input.providerTurnId ?? null}),
        session_epoch = COALESCE(session_epoch, ${input.sessionEpoch ?? null}),
        updated_at = ${input.at}, revision = revision + 1
      WHERE attempt_id = ${a.attemptId} AND owner = ${a.owner} AND revision = ${a.revision}
        AND state = ${a.state}
        -- Retired native attempts can only be cancelled before dispatch. Keep all evidence.
        AND (stage != 'native' OR (state = 'prepared' AND dispatched_at IS NULL
          AND ${state} IN ('cancelled', 'stale', 'unavailable')
          AND ${input.result ?? null} IS NULL
          AND ${input.providerSessionId ?? null} IS NULL
          AND ${input.providerTurnId ?? null} IS NULL
          AND ${input.sessionEpoch ?? null} IS NULL))
        AND (${input.result ?? null} IS NULL OR result IS NULL OR result = ${input.result ?? null})
        AND (${input.providerSessionId ?? null} IS NULL OR provider_session_id IS NULL
          OR provider_session_id = ${input.providerSessionId ?? null})
        AND (${input.providerTurnId ?? null} IS NULL OR provider_turn_id IS NULL
          OR provider_turn_id = ${input.providerTurnId ?? null})
        AND (${input.sessionEpoch ?? null} IS NULL OR session_epoch IS NULL
          OR session_epoch = ${input.sessionEpoch ?? null})
      RETURNING attempt_id AS "attemptId"`.pipe(
      Effect.map((rows) => rows.length === 1),
      fail("settleAttempt"),
    );
  };
  return { listAttempts, prepareAttempt, claimDispatch, settleAttempt };
});
