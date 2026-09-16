import { OrchestrationMessage } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import { LearningJobAttempt, type LearningJobRepositoryShape } from "../Services/LearningJobs.ts";

export function makeLearningJobQueries(sql: SqlClient.SqlClient) {
  const recoverInterrupted: LearningJobRepositoryShape["recoverInterrupted"] = Effect.fn(
    "LearningJobRepository.recoverInterrupted",
  )(function* ({ now }) {
    const rows = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const reviewing = yield* sql<LearningJobAttempt>`
            SELECT job_id AS "jobId", thread_id AS "threadId", turn_id AS "turnId",
              memory_user_message_count AS "memoryUserMessageCount", attempt_count AS "attemptCount"
            FROM learning_jobs WHERE state = 'reviewing'
          `;
          yield* sql`DELETE FROM thread_activity_leases WHERE activity_kind = 'learning'`;
          yield* sql`UPDATE learning_jobs SET state = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'queued' END,
        next_attempt_at = NULL, outcome = 'interrupted', updated_at = ${now} WHERE state = 'reviewing'`;
          return reviewing;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("LearningJobRepository.recoverInterrupted")));
    return yield* Schema.decodeUnknownEffect(Schema.Array(LearningJobAttempt))(rows).pipe(
      Effect.mapError(toPersistenceDecodeError("LearningJobRepository.recoverInterrupted:decode")),
    );
  });
  const hasPending: LearningJobRepositoryShape["hasPending"] = Effect.fn(
    "LearningJobRepository.hasPending",
  )(function* ({ threadId }) {
    const rows = yield* sql`SELECT 1 FROM learning_jobs WHERE thread_id = ${threadId}
        AND state IN ('queued', 'reviewing')
        UNION ALL SELECT 1 FROM thread_activity_leases WHERE thread_id = ${threadId}
          AND activity_kind = 'learning' LIMIT 1`.pipe(
      Effect.mapError(toPersistenceSqlError("LearningJobRepository.hasPending")),
    );
    return rows.length > 0;
  });
  const countFinalizedUserMessages: LearningJobRepositoryShape["countFinalizedUserMessages"] =
    Effect.fn("LearningJobRepository.countFinalizedUserMessages")(function* ({ threadId }) {
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user' AND is_streaming = 0`.pipe(
        Effect.mapError(toPersistenceSqlError("LearningJobRepository.countFinalizedUserMessages")),
      );
      return rows[0]?.count ?? 0;
    });
  const getReviewMessages: LearningJobRepositoryShape["getReviewMessages"] = Effect.fn(
    "LearningJobRepository.getReviewMessages",
  )(function* ({ threadId, turnId }) {
    // Resolve the source turn before selecting a bounded window, never include newer turns.
    const rows = yield* sql`
        WITH endpoint AS (
          SELECT created_at, message_id FROM projection_thread_messages
          WHERE thread_id = ${threadId} AND turn_id = ${turnId} AND is_streaming = 0
          ORDER BY created_at DESC, message_id DESC LIMIT 1
        ) SELECT m.message_id AS id, m.role, substr(m.text, 1, 4000) AS text,
          m.turn_id AS "turnId", m.is_streaming AS streaming,
          m.created_at AS "createdAt", m.updated_at AS "updatedAt"
        FROM projection_thread_messages m, endpoint e
        WHERE m.thread_id = ${threadId} AND m.is_streaming = 0
          AND (m.created_at < e.created_at OR (m.created_at = e.created_at AND m.message_id <= e.message_id))
        ORDER BY m.created_at DESC, m.message_id DESC LIMIT 100
      `.pipe(Effect.mapError(toPersistenceSqlError("LearningJobRepository.getReviewMessages")));
    // A long assistant turn can fill the window; retain its preceding user prompt.
    let selectedRows = [...rows];
    if (rows.length > 0 && !rows.some((row) => row.role === "user")) {
      const endpoint = rows[0]!;
      const users = yield* sql`
        SELECT message_id AS id, role, substr(text, 1, 4000) AS text,
          turn_id AS "turnId", is_streaming AS streaming,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_thread_messages WHERE thread_id = ${threadId}
          AND role = 'user' AND is_streaming = 0
          AND (created_at < ${endpoint.createdAt} OR (created_at = ${endpoint.createdAt} AND message_id <= ${endpoint.id}))
        ORDER BY created_at DESC, message_id DESC LIMIT 1
      `.pipe(Effect.mapError(toPersistenceSqlError("LearningJobRepository.getReviewMessages")));
      if (users[0]) selectedRows = [...rows.slice(0, 99), users[0]];
    }
    return yield* Schema.decodeUnknownEffect(Schema.Array(OrchestrationMessage))(
      selectedRows.toReversed().map((row) => ({
        id: row.id,
        role: row.role,
        text: row.text,
        turnId: row.turnId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        streaming: row.streaming === 1,
      })),
    ).pipe(Effect.mapError(toPersistenceDecodeError("LearningJobRepository.getReviewMessages")));
  });
  const acquireLease: LearningJobRepositoryShape["acquireLease"] = Effect.fn(
    "LearningJobRepository.acquireLease",
  )(function* ({ jobId, threadId }) {
    const rows = yield* sql`
        INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
        SELECT ${`learning:${jobId}`}, t.thread_id, 'learning', ${new Date().toISOString()}
        FROM projection_threads t WHERE t.thread_id = ${threadId}
          AND t.deleted_at IS NULL AND t.deleting_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM thread_activity_leases WHERE thread_id = t.thread_id AND activity_kind = 'learning')
          AND NOT EXISTS (SELECT 1 FROM orchestration_deletion_markers WHERE entity_kind = 'thread' AND entity_id = t.thread_id)
          AND NOT EXISTS (SELECT 1 FROM purge_resource_claims WHERE entity_kind = 'thread' AND entity_id = t.thread_id)
        ON CONFLICT(lease_id) DO NOTHING RETURNING lease_id
      `.pipe(Effect.mapError(toPersistenceSqlError("LearningJobRepository.acquireLease")));
    return rows.length > 0;
  });
  const releaseLease: LearningJobRepositoryShape["releaseLease"] = Effect.fn(
    "LearningJobRepository.releaseLease",
  )(function* (jobId) {
    yield* sql`DELETE FROM thread_activity_leases WHERE lease_id = ${`learning:${jobId}`} AND activity_kind = 'learning'`.pipe(
      Effect.mapError(toPersistenceSqlError("LearningJobRepository.releaseLease")),
    );
  });
  return {
    recoverInterrupted,
    hasPending,
    countFinalizedUserMessages,
    getReviewMessages,
    acquireLease,
    releaseLease,
  };
}
