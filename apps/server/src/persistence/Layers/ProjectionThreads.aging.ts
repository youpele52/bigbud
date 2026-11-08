import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Same definition as effectiveOrganizationActivity; automatic changedAt is never an anchor. */
export const organizationActivitySql = (sql: SqlClient.SqlClient) => sql`MAX(
  COALESCE(t.last_activity_at, t.created_at),
  COALESCE(CASE WHEN t.organization_age_provenance = 'pending'
    THEN t.organization_changed_at ELSE t.organization_activity_at END, t.created_at),
  COALESCE(turn.completed_at, t.created_at)
)`;
