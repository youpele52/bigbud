import type { ThreadId } from "@bigbud/contracts";
import type {
  ListPendingThreadSnoozesInput,
  PendingThreadSnooze,
} from "../Services/ProjectionThreads.ts";
import { isDeliberateOrganizationChange } from "../../orchestration/threadOrganization.aging.ts";
import type { ThreadOrganizationUpdatedPayload } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import type { ThreadOrganization } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";

/**
 * Writes the `projection_threads.organization_*` columns (migration 141). Only organization
 * events and unarchive change them, so the general thread upsert leaves them untouched.
 */
export function makeSetThreadOrganization(sql: SqlClient.SqlClient) {
  return (input: {
    readonly threadId: ThreadId;
    readonly organization: ThreadOrganization;
    readonly reason?: ThreadOrganizationUpdatedPayload["reason"];
    readonly source?: ThreadOrganizationUpdatedPayload["source"];
  }) =>
    sql`UPDATE projection_threads
      SET organization_activity_at = NULLIF(MAX(
          COALESCE(CASE WHEN organization_age_provenance = 'pending'
            THEN organization_changed_at ELSE organization_activity_at END, ''),
          ${isDeliberateOrganizationChange({ reason: input.reason ?? "move", ...(input.source ? { source: input.source } : {}) }) ? (input.organization.changedAt ?? "") : ""}
        ), ''),
        organization_age_provenance = CASE WHEN organization_age_provenance = 'pending'
          THEN CASE WHEN organization_revision = 0 THEN 'known' ELSE 'fallback' END
          ELSE organization_age_provenance END,
        organization_state = ${input.organization.state},
        organization_revision = ${input.organization.revision},
        organization_changed_at = ${input.organization.changedAt},
        organization_snooze_id = ${input.organization.snooze?.id ?? null},
        organization_snooze_until = ${input.organization.snooze?.until ?? null}
      WHERE thread_id = ${input.threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.setOrganization:query")),
    );
}

/** Pages pending snoozes by deadline through `idx_projection_threads_pending_snooze`. */
export function makeListPendingThreadSnoozes(sql: SqlClient.SqlClient) {
  return (input: ListPendingThreadSnoozesInput) => {
    const afterUntil = input.after?.until ?? null;
    const afterThreadId = input.after?.threadId ?? null;
    return sql<PendingThreadSnooze>`
      SELECT
        thread_id AS "threadId",
        organization_snooze_id AS "snoozeId",
        organization_snooze_until AS "until"
      FROM projection_threads
      WHERE organization_snooze_id IS NOT NULL
        AND deleted_at IS NULL
        AND archived_at IS NULL
        AND deleting_at IS NULL
        AND (
          ${afterUntil} IS NULL
          OR organization_snooze_until > ${afterUntil}
          OR (organization_snooze_until = ${afterUntil} AND thread_id > ${afterThreadId})
        )
      ORDER BY organization_snooze_until ASC, thread_id ASC
      LIMIT ${input.limit}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listPendingSnoozes:query")),
    );
  };
}

/** SQL text selecting a thread's organization as a JSON object matching `ThreadOrganization`. */
export function threadOrganizationJsonSqlText(alias?: string): string {
  const column = (name: string) => (alias === undefined ? name : `${alias}.${name}`);
  return `json_object(
    'state', ${column("organization_state")},
    'revision', ${column("organization_revision")},
    'changedAt', ${column("organization_changed_at")},
    'activityAt', NULLIF(CASE WHEN ${column("organization_age_provenance")} = 'pending'
      THEN ${column("organization_changed_at")} ELSE ${column("organization_activity_at")} END, ''),
    'ageProvenance', CASE WHEN ${column("organization_revision")} = 0 THEN 'known'
      ELSE ${column("organization_age_provenance")} END,
    'snooze', CASE WHEN ${column("organization_snooze_id")} IS NULL THEN NULL
      ELSE json_object(
        'id', ${column("organization_snooze_id")},
        'until', ${column("organization_snooze_until")}
      ) END
  )`;
}

/**
 * Selects a thread's organization as a JSON object. Decode it with
 * `Schema.fromJsonString(ThreadOrganization)`. `alias` is the `projection_threads` table alias.
 */
export function threadOrganizationJsonSql(sql: SqlClient.SqlClient, alias?: string) {
  return sql.unsafe(threadOrganizationJsonSqlText(alias));
}
