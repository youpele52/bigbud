import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";

export function retainedRustTerminalOwnerKey(row: {
  readonly leaseId: string;
  readonly threadId: string;
  readonly runtimeKind: string;
}): string {
  const prefix = `terminal:${row.threadId}:`;
  return row.runtimeKind === "terminal" &&
    row.leaseId.startsWith(prefix) &&
    row.leaseId.length > prefix.length
    ? `terminal:${JSON.stringify([row.threadId, row.leaseId.slice(prefix.length)])}`
    : "";
}

/** Heartbeat expiry and PID death are not definitive release of a durable Rust resource. */
export function rustTerminalLeaseReleaseAllowed(
  sql: SqlClient.SqlClient,
  ownerKey: string | Fragment,
) {
  return sql`NOT EXISTS (
    SELECT 1 FROM remote_agent_runtime_owners rust_owner
    WHERE rust_owner.owner_key = ${ownerKey} AND CASE
      WHEN NOT json_valid(rust_owner.route_json) THEN 1
      WHEN json_type(rust_owner.route_json, '$.target') IS NOT 'text'
        OR json_type(rust_owner.route_json, '$.state') IS NOT 'text' THEN 1
      WHEN json_extract(rust_owner.route_json, '$.target') LIKE 'remote-backend:%'
        AND json_extract(rust_owner.route_json, '$.state') <> 'terminal' THEN 1
      ELSE 0 END
  )`;
}
