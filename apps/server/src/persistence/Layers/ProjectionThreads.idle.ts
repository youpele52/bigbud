import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { organizationActivitySql } from "./ProjectionThreads.aging.ts";
import { unresolvedModelChoiceRequestsCtes } from "../DelegatedModelChoiceSql.ts";
import {
  organizationRuntimeQuietSql,
  organizationAttentionSql,
} from "./ProjectionThreads.quiescence.ts";
import { toPersistenceSqlError } from "../Errors.ts";
import type {
  IdleThreadCandidate,
  ListIdleThreadCandidatesInput,
} from "../Services/ProjectionThreads.ts";

/**
 * Unsnoozed threads in one of `states` quiet since `cutoff`, oldest activity first. The activity anchor is the later
 * of the last thread event (`last_activity_at`, which only ever over-counts activity) and the
 * source-aware deliberate organization/work-completion anchor, never automatic changedAt. Every runtime and
 * attention gate is checked here from authoritative projections, then rechecked by the decider:
 * running or starting sessions and turns, queued or held prompts, pending starts and turn
 * control, recovery, pending approvals and questions, live delegations and watches, and an
 * unfinished Codex rewind or unacknowledged inspection (provider runtime, not the read model).
 */
export function makeListIdleThreadCandidates(sql: SqlClient.SqlClient) {
  const activity = organizationActivitySql(sql);
  return (input: ListIdleThreadCandidatesInput) =>
    sql<IdleThreadCandidate>`
      WITH ${unresolvedModelChoiceRequestsCtes(sql, input.threadId)}
      SELECT
        t.thread_id AS "threadId",
        t.organization_state AS "state",
        t.organization_revision AS "revision",
        ${activity} AS "activityAt"
      FROM projection_threads t
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      LEFT JOIN projection_turns turn
        ON turn.thread_id = t.thread_id AND turn.turn_id = t.latest_turn_id
      WHERE t.organization_state IN ${sql.in(input.states)}
        AND ${input.threadId ? sql`t.thread_id = ${input.threadId}` : sql`1 = 1`}
        AND ${input.excludeThreadIds?.length ? sql` t.thread_id NOT IN ${sql.in(input.excludeThreadIds)}` : sql`1 = 1`}
        AND (t.organization_revision = 0 OR t.organization_age_provenance <> 'pending')
        AND t.organization_snooze_id IS NULL
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND t.deleting_at IS NULL
        AND t.purpose = 'standard'
        AND ${activity} <= ${input.cutoff}
        AND ${input.after ? sql`(${activity}, t.thread_id) > (${input.after.activityAt}, ${input.after.threadId})` : sql`1 = 1`}
        AND (${organizationRuntimeQuietSql(sql)})
        AND NOT (${organizationAttentionSql(sql)})
      ORDER BY "activityAt" ASC, t.thread_id ASC
      LIMIT ${input.limit}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listIdleCandidates:query")),
    );
}
