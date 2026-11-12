import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { directShellOwnerKey } from "../terminal/Layers/DirectShellLaunch.owner";

/** Local PID death / lease expiry never proves a direct execution-host shell has stopped. */
export function retainedDirectOwnerKey(row: {
  leaseId: string;
  threadId: string;
  runtimeKind: string;
}): string {
  const prefix = `terminal:${row.threadId}:`;
  return row.runtimeKind === "terminal" &&
    row.leaseId.startsWith(prefix) &&
    row.leaseId.length > prefix.length
    ? directShellOwnerKey(row.threadId, row.leaseId.slice(prefix.length))
    : "";
}
export function directLeaseReleaseAllowed(sql: SqlClient.SqlClient, ownerKey: string) {
  return sql`NOT EXISTS (SELECT 1 FROM direct_shell_launch_owners WHERE owner_key = ${ownerKey})`;
}
