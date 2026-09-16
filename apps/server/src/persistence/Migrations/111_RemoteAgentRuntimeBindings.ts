import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE remote_agent_runtime_owners (
    owner_key TEXT PRIMARY KEY NOT NULL,
    route_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE remote_agent_connection_bindings (
    target_id TEXT NOT NULL, connection_id TEXT NOT NULL, binding_json TEXT NOT NULL,
    PRIMARY KEY (target_id, connection_id)
  )`;
  yield* sql`CREATE TABLE remote_agent_target_admissions (
    target_id TEXT PRIMARY KEY NOT NULL, connection_id TEXT NOT NULL,
    FOREIGN KEY (target_id, connection_id) REFERENCES remote_agent_connection_bindings(target_id, connection_id)
  )`;
  yield* sql`CREATE INDEX remote_agent_runtime_owners_state_idx
    ON remote_agent_runtime_owners (json_extract(route_json, '$.state'))`;
  yield* sql`CREATE INDEX remote_agent_runtime_owners_target_state_idx
    ON remote_agent_runtime_owners (json_extract(route_json, '$.target'), json_extract(route_json, '$.state'))`;
});
