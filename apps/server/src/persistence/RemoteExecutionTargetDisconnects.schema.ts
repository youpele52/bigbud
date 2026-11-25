import type { SqlClient } from "effect/unstable/sql/SqlClient";

// The legacy build and the new writer share this exact flag table. Absence of a
// row still means connected, irrespective of any transition metadata.
export const createRemoteExecutionTargetDisconnectsTable = (sql: SqlClient) => sql`
  CREATE TABLE IF NOT EXISTS remote_execution_target_disconnects (
    target_id TEXT PRIMARY KEY NOT NULL,
    disconnected_at INTEGER NOT NULL
  )
`;
