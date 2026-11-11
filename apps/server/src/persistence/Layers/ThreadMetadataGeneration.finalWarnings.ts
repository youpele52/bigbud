import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import type { ThreadMetadataGenerationRepositoryShape } from "../Services/ThreadMetadataGeneration.ts";

/** Existing warning tables are retained unchanged. A separate epoch namespace deduplicates
 * final warnings per thread/operation, independently of configuration-wide settings warnings. */
export function makeMetadataFinalWarnings(sql: SqlClient.SqlClient) {
  // Definitive exhaustion includes duplicate-target skips and unavailable paths, not just
  // failed thread-model calls. Only conclusively failed/never-dispatched evidence is safe.
  const eligibleJob = sql`j.state IN ('exhausted', 'unavailable')
    AND NOT EXISTS (SELECT 1 FROM thread_metadata_generation_attempts a
      WHERE a.job_id = j.job_id AND (a.stage = 'native' OR NOT (
        a.state IN ('failed', 'unavailable') OR (a.state = 'cancelled'
          AND a.cancelled_before_dispatch_at_deadline = 1 AND a.revision = 1
          AND a.dispatched_at IS NULL AND a.result IS NULL
          AND a.provider_session_id IS NULL AND a.provider_turn_id IS NULL AND a.session_epoch IS NULL))))
    AND EXISTS (SELECT 1 FROM projection_threads t
      LEFT JOIN thread_metadata_generation_state s ON s.thread_id = t.thread_id
      WHERE t.thread_id = j.thread_id AND t.archived_at IS NULL
        AND t.deleting_at IS NULL AND t.deleted_at IS NULL
        AND CASE j.operation WHEN 'title' THEN
          COALESCE(s.title_revision, 0) = j.expected_revision
          AND t.title = json_extract(j.context_json, '$.initialTitle')
        ELSE COALESCE(s.summary_revision, 0) = 0 AND j.expected_revision = 0
          AND t.elevator_summary_message_count = 0
          AND (NULLIF(TRIM(t.elevator_summary), '') IS NULL OR t.elevator_summary = t.title)
          AND json_extract(j.context_json, '$.previousMessageCount') = 0 END)`;
  const enqueueFinalWarning: ThreadMetadataGenerationRepositoryShape["enqueueFinalWarning"] = ({
    jobId,
    at,
  }) =>
    sql<{ id: string }>`INSERT INTO thread_metadata_generation_warnings (
        warning_id, config_epoch, thread_id, operation, created_at, primary_failures
      ) SELECT 'metadata-final-warning:' || j.job_id,
        'metadata-final:' || j.operation || ':' || j.thread_id,
        j.thread_id, j.operation, ${at},
        MIN(3, (SELECT COUNT(*) FROM thread_metadata_generation_attempts a
          WHERE a.job_id = j.job_id AND a.stage = 'primary' AND a.state = 'failed'))
      FROM thread_metadata_generation_jobs j WHERE j.job_id = ${jobId} AND ${eligibleJob}
      ON CONFLICT DO NOTHING RETURNING warning_id AS id`.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.enqueueFinalWarning")),
    );
  // Recheck in the same statement that claims delivery, including edits after enqueue.
  const deliverable = sql`(warning_id NOT LIKE 'metadata-final-warning:%' OR EXISTS (
    SELECT 1 FROM thread_metadata_generation_jobs j
    WHERE j.job_id = substr(warning_id, length('metadata-final-warning:') + 1)
      AND ${eligibleJob}))`;
  return { enqueueFinalWarning, deliverable };
}
