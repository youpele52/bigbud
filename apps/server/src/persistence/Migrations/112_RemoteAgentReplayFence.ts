import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE remote_agent_replay_fence (
    slot INTEGER PRIMARY KEY CHECK (slot >= 0 AND slot < 65536),
    bits INTEGER NOT NULL CHECK (bits >= 0 AND bits <= 255)
  )`;
});
