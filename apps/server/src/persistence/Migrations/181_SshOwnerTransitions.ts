import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createRemoteExecutionTargetDisconnectsTable } from "../RemoteExecutionTargetDisconnects.schema.ts";

// Preparatory schema only. The legacy writer continues to use the original
// disconnect table; no tokens are installed and no flags are migrated or cleared.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* createRemoteExecutionTargetDisconnectsTable(sql);
  yield* sql`
    CREATE TABLE IF NOT EXISTS ssh_owner_writer (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      writer_epoch TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ssh_target_transition (
      target_id TEXT PRIMARY KEY NOT NULL,
      seq INTEGER NOT NULL CHECK (seq > 0),
      last_request_id TEXT NOT NULL,
      last_digest TEXT NOT NULL
    )
  `;
});
