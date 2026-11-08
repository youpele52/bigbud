import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { terminalTurnControlStates } from "../../orchestration/QueuedPromptPolicy.logic.ts";
import { codexRewindAbsent } from "./ProviderSessionRuntime.rewind.ts";

/** Shared alias contract: t=thread,s=session,turn=latest turn. No transcript reads. */
export function organizationRuntimeQuietSql(sql: SqlClient.SqlClient) {
  return sql`(s.status IS NULL OR s.status NOT IN ('starting', 'running'))
    AND (turn.state IS NULL OR turn.state <> 'running')
    AND (t.queued_prompts_json IS NULL OR t.queued_prompts_json IN ('', '[]'))
    AND COALESCE(t.queue_hold, 0) = 0 AND t.pending_turn_start_json IS NULL
    AND (t.pending_turn_control_operation_json IS NULL OR CASE WHEN json_valid(t.pending_turn_control_operation_json)
      THEN json_extract(t.pending_turn_control_operation_json, '$.state') IN ${sql.in([...terminalTurnControlStates])} ELSE 0 END)
    AND t.pending_interrupt_flush_intent_json IS NULL AND t.recovery_json IS NULL
    AND NOT EXISTS (SELECT 1 FROM thread_delegations d
      WHERE (d.caller_thread_id = t.thread_id OR d.child_thread_id = t.thread_id)
        AND d.state NOT IN ('completed', 'compensated', 'failed'))
    AND NOT EXISTS (SELECT 1 FROM projection_thread_watches w
      WHERE (w.watcher_thread_id = t.thread_id OR w.watched_thread_id = t.thread_id) AND w.status = 'active')
    AND NOT EXISTS (SELECT 1 FROM provider_session_runtime r WHERE r.thread_id = t.thread_id AND NOT (${codexRewindAbsent(sql)}))
    AND NOT EXISTS (SELECT 1 FROM projection_thread_tasks task WHERE task.thread_id = t.thread_id
      AND CASE WHEN json_valid(task.task_json) THEN json_extract(task.task_json, '$.kind') = 'providerSubagent'
        AND json_extract(task.task_json, '$.status') IN ('pending', 'inProgress') ELSE 1 END)`;
}
/** Requires unresolvedModelChoiceRequestsCtes in the owning query. */
export function organizationAttentionSql(sql: SqlClient.SqlClient) {
  return sql`EXISTS (SELECT 1 FROM projection_pending_approvals a WHERE a.thread_id = t.thread_id AND a.status = 'pending')
    OR EXISTS (SELECT 1 FROM projection_pending_user_inputs u WHERE u.thread_id = t.thread_id AND u.status = 'pending')
    OR EXISTS (SELECT 1 FROM model_choice_unresolved m WHERE m.thread_id = t.thread_id)`;
}
export function organizationKnownBusySql(sql: SqlClient.SqlClient) {
  return sql`s.status IN ('starting', 'running') OR turn.state = 'running'
    OR t.pending_turn_start_json IS NOT NULL OR COALESCE(t.queue_hold, 0) <> 0
    OR (t.queued_prompts_json IS NOT NULL AND t.queued_prompts_json NOT IN ('', '[]') AND json_valid(t.queued_prompts_json))
    OR EXISTS (SELECT 1 FROM thread_delegations d WHERE (d.caller_thread_id = t.thread_id OR d.child_thread_id = t.thread_id)
      AND d.state NOT IN ('completed', 'compensated', 'failed'))
    OR EXISTS (SELECT 1 FROM projection_thread_watches w WHERE (w.watcher_thread_id = t.thread_id OR w.watched_thread_id = t.thread_id) AND w.status = 'active')
    OR EXISTS (SELECT 1 FROM projection_thread_tasks task WHERE task.thread_id = t.thread_id AND json_valid(task.task_json)
      AND json_extract(task.task_json, '$.kind') = 'providerSubagent' AND json_extract(task.task_json, '$.status') IN ('pending', 'inProgress'))`;
}
