import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE remote_agent_restart_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
     route_json TEXT NOT NULL,
     phase TEXT NOT NULL,
     revision INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX remote_agent_restart_requests_target_idx
    ON remote_agent_restart_requests (target_id, updated_at)`;
});
