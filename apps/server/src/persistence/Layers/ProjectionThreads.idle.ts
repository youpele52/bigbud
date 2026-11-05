import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { codexRewindAbsent } from "./ProviderSessionRuntime.rewind.ts";
import type {
  IdleThreadCandidate,
  ListIdleThreadCandidatesInput,
} from "../Services/ProjectionThreads.ts";

/**
 * Unsnoozed threads in one of `states` quiet since `cutoff`, oldest activity first. The activity anchor is the later
 * of the last thread event (`last_activity_at`, which only ever over-counts activity) and the
 * last organization change, so a deliberate move to Present restarts the wait. Every runtime and
 * attention gate is checked here from authoritative projections, then rechecked by the decider:
 * running or starting sessions and turns, queued or held prompts, pending starts and turn
 * control, recovery, pending approvals and questions, live delegations and watches, and an
 * unfinished Codex rewind or unacknowledged inspection (provider runtime, not the read model).
 */
export function makeListIdleThreadCandidates(sql: SqlClient.SqlClient) {
  return (input: ListIdleThreadCandidatesInput) =>
    sql<IdleThreadCandidate>`
      SELECT
        t.thread_id AS "threadId",
        t.organization_state AS "state",
        t.organization_revision AS "revision",
        MAX(
          COALESCE(t.last_activity_at, t.created_at),
          COALESCE(t.organization_changed_at, t.created_at)
        ) AS "activityAt"
      FROM projection_threads t
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      LEFT JOIN projection_turns turn
        ON turn.thread_id = t.thread_id AND turn.turn_id = t.latest_turn_id
      WHERE t.organization_state IN ${sql.in(input.states)}
        AND t.organization_snooze_id IS NULL
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND t.deleting_at IS NULL
        AND t.purpose = 'standard'
        AND MAX(
          COALESCE(t.last_activity_at, t.created_at),
          COALESCE(t.organization_changed_at, t.created_at)
        ) <= ${input.cutoff}
        AND (s.status IS NULL OR s.status NOT IN ('starting', 'running'))
        AND (turn.state IS NULL OR turn.state <> 'running')
        AND (t.queued_prompts_json IS NULL OR t.queued_prompts_json IN ('', '[]'))
        AND COALESCE(t.queue_hold, 0) = 0
        AND t.pending_turn_start_json IS NULL
        AND t.pending_turn_control_operation_json IS NULL
        AND t.pending_interrupt_flush_intent_json IS NULL
        AND t.recovery_json IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM projection_pending_approvals a
          WHERE a.thread_id = t.thread_id AND a.status = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM projection_pending_user_inputs u
          WHERE u.thread_id = t.thread_id AND u.status = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM thread_delegations d
          WHERE (d.caller_thread_id = t.thread_id OR d.child_thread_id = t.thread_id)
            AND d.state NOT IN ('completed', 'compensated', 'failed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_watches w
          WHERE (w.watcher_thread_id = t.thread_id OR w.watched_thread_id = t.thread_id)
            AND w.status = 'active'
        )
        AND NOT EXISTS (
          SELECT 1 FROM provider_session_runtime r
          WHERE r.thread_id = t.thread_id AND NOT (${codexRewindAbsent(sql)})
        )
      ORDER BY "activityAt" ASC, t.thread_id ASC
      LIMIT ${input.limit}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listIdleCandidates:query")),
    );
}
