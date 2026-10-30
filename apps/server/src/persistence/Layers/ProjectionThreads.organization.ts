import type { ThreadId } from "@bigbud/contracts";
import type { ThreadOrganization } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";

/**
 * Writes the `projection_threads.organization_*` columns (migration 141). Only organization
 * events and unarchive change them, so the general thread upsert leaves them untouched.
 */
export function makeSetThreadOrganization(sql: SqlClient.SqlClient) {
  return (input: { readonly threadId: ThreadId; readonly organization: ThreadOrganization }) =>
    sql`UPDATE projection_threads
      SET organization_state = ${input.organization.state},
        organization_revision = ${input.organization.revision},
        organization_changed_at = ${input.organization.changedAt},
        organization_snooze_id = ${input.organization.snooze?.id ?? null},
        organization_snooze_until = ${input.organization.snooze?.until ?? null}
      WHERE thread_id = ${input.threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.setOrganization:query")),
    );
}

/** SQL text selecting a thread's organization as a JSON object matching `ThreadOrganization`. */
export function threadOrganizationJsonSqlText(alias?: string): string {
  const column = (name: string) => (alias === undefined ? name : `${alias}.${name}`);
  return `json_object(
    'state', ${column("organization_state")},
    'revision', ${column("organization_revision")},
    'changedAt', ${column("organization_changed_at")},
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
