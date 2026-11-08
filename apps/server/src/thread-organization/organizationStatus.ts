import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrganizationLimitReason } from "./organizationLifecycle.ts";

export type OrganizationStatus = {
  state: "syncing" | "healthy" | "paused";
  changedAtMs: number;
  /** Set only while paused by a terminal limit that waits for a settings change. */
  reason?: OrganizationLimitReason;
};
const statuses = new WeakMap<SqlClient.SqlClient, OrganizationStatus>();
export function organizationStatus(sql: SqlClient.SqlClient): OrganizationStatus {
  return statuses.get(sql) ?? { state: "syncing", changedAtMs: 0 };
}
export function setOrganizationStatus(
  sql: SqlClient.SqlClient,
  state: OrganizationStatus["state"],
  reason?: OrganizationLimitReason,
) {
  const current = statuses.get(sql);
  if (current?.state === state && current.reason === reason) return;
  statuses.set(sql, { state, changedAtMs: Date.now(), ...(reason ? { reason } : {}) });
}
