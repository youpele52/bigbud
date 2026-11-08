import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { organizationActivitySql } from "../persistence/Layers/ProjectionThreads.aging.ts";
import {
  organizationAttentionSql,
  organizationKnownBusySql,
  organizationRuntimeQuietSql,
} from "../persistence/Layers/ProjectionThreads.quiescence.ts";
import { unresolvedModelChoiceRequestsCtes } from "../persistence/DelegatedModelChoiceSql.ts";
import { orchestrationSequenceFrontierSql } from "../persistence/OrchestrationSequenceFrontier.ts";

export interface RawOrganizationFacts {
  threadId: string;
  organizationRevision: number;
  section: string;
  activityAt: string;
  workCompletedAt: string;
  agePending: number;
  inScope: number;
  work: number;
  actionable: number;
  attentionIdsJson: string;
  snoozeIdentity: string | null;
  snoozeUntil: string | null;
  factVersion: number | null;
  semanticDigest: string | null;
  lastWorkState: string | null;
  lastWorkCompletedAtMs: number | null;
  manualUntilMs: number | null;
  manualAttentionWatermark: number | null;
  attentionWatermark: number | null;
  graceUntilMs: number | null;
  attentionHistoryJson: string | null;
  deleted: number | null;
  needsAttentionReminder: number | null;
  latestAutomaticMoveId: string | null;
}
export function readOrganizationRawFacts(
  sql: SqlClient.SqlClient,
  threadId?: string,
  after?: string,
) {
  return sql<RawOrganizationFacts>`WITH ${unresolvedModelChoiceRequestsCtes(sql, threadId)}
    SELECT t.thread_id AS "threadId", t.organization_revision AS "organizationRevision",
      t.organization_state AS section, ${organizationActivitySql(sql)} AS "activityAt",
      MAX(COALESCE(turn.completed_at, ''), COALESCE((SELECT MAX(CASE WHEN json_valid(task.task_json)
        AND json_extract(task.task_json, '$.kind') = 'providerSubagent'
        AND json_extract(task.task_json, '$.status') IN ('completed', 'failed', 'stopped')
        THEN COALESCE(json_extract(task.task_json, '$.endedAt'), task.updated_at) ELSE NULL END)
        FROM projection_thread_tasks task WHERE task.thread_id = t.thread_id), '')) AS "workCompletedAt",
      (t.organization_revision > 0 AND t.organization_age_provenance = 'pending') AS "agePending",
      (t.archived_at IS NULL AND t.deleting_at IS NULL AND t.purpose = 'standard') AS "inScope",
      CASE WHEN (${organizationKnownBusySql(sql)}) THEN 2
        WHEN NOT (${organizationRuntimeQuietSql(sql)}) THEN 3 ELSE 1 END AS work,
      (${organizationAttentionSql(sql)}) AS actionable,
      (SELECT json_group_array(identity) FROM (
        SELECT 'approval:' || a.request_id AS identity FROM projection_pending_approvals a WHERE a.thread_id = t.thread_id AND a.status = 'pending'
        UNION ALL SELECT 'input:' || u.request_id FROM projection_pending_user_inputs u WHERE u.thread_id = t.thread_id AND u.status = 'pending'
        UNION ALL SELECT 'choice:' || m.activity_id FROM model_choice_unresolved m WHERE m.thread_id = t.thread_id
        ORDER BY identity)) AS "attentionIdsJson",
      t.organization_snooze_id AS "snoozeIdentity", t.organization_snooze_until AS "snoozeUntil",
      runtime.fact_version AS "factVersion", runtime.semantic_digest AS "semanticDigest",
      runtime.last_work_state AS "lastWorkState", runtime.last_work_completed_at_ms AS "lastWorkCompletedAtMs",
      runtime.manual_until_ms AS "manualUntilMs", runtime.manual_attention_watermark AS "manualAttentionWatermark",
      runtime.attention_watermark AS "attentionWatermark", runtime.grace_until_ms AS "graceUntilMs",
      runtime.attention_ids_json AS "attentionHistoryJson", runtime.deleted,
      runtime.needs_attention_reminder AS "needsAttentionReminder",
      runtime.latest_automatic_move_id AS "latestAutomaticMoveId"
    FROM projection_threads t
    LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
    LEFT JOIN projection_turns turn ON turn.thread_id = t.thread_id AND turn.turn_id = t.latest_turn_id
    LEFT JOIN thread_organization_runtime_threads runtime ON runtime.thread_id = t.thread_id
    WHERE t.deleted_at IS NULL AND t.purpose = 'standard'
      AND ${threadId === undefined ? sql`1 = 1` : sql`t.thread_id = ${threadId}`}
      AND ${after === undefined ? sql`1 = 1` : sql`t.thread_id > ${after}`}
    ORDER BY t.thread_id LIMIT ${threadId === undefined ? 256 : 1}`;
}
export function readOrganizationFrontier(sql: SqlClient.SqlClient) {
  return sql<{
    frontier: number;
    projected: number | null;
    projectorCount: number;
    mismatch: number;
  }>`
    SELECT ${orchestrationSequenceFrontierSql(sql)} AS frontier,
      (SELECT MIN(last_applied_sequence) FROM projection_state) AS projected,
      (SELECT COUNT(*) FROM projection_state) AS "projectorCount",
      (SELECT COUNT(*) FROM projection_state WHERE last_applied_sequence <> ${orchestrationSequenceFrontierSql(sql)}) AS mismatch`;
}

/** Cheap indexed membership page. Heavy facts are queried only for the bounded selected IDs. */
export function readOrganizationThreadIds(sql: SqlClient.SqlClient, after?: string, limit = 32) {
  return sql<{ threadId: string }>`SELECT thread_id AS "threadId" FROM projection_threads
    WHERE deleted_at IS NULL AND purpose = 'standard'
    AND ${after === undefined ? sql`1 = 1` : sql`thread_id > ${after}`}
    ORDER BY thread_id LIMIT ${limit}`;
}
/** Cheap indexed membership count: sizes the capture budget and refuses over-limit tables
 * before any heavy per-row read.
 */
export function countOrganizationThreads(sql: SqlClient.SqlClient) {
  return sql<{ count: number }>`SELECT COUNT(*) AS count FROM projection_threads
    WHERE deleted_at IS NULL AND purpose = 'standard'`;
}
