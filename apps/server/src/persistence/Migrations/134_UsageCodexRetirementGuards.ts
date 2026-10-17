import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { decodeCodexState } from "../Layers/ProjectionUsageCodex.state.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_usage_codex_retired_turns (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  ) WITHOUT ROWID`;
  let after = "";
  while (true) {
    const rows = yield* sql<{ thread_id: string; state_json: string }>`SELECT thread_id, state_json
      FROM projection_usage_codex_state WHERE thread_id > ${after} ORDER BY thread_id LIMIT 100`;
    if (rows.length === 0) break;
    for (const row of rows) {
      const { state, retired } = decodeCodexState(row.state_json);
      for (const turnId of retired) {
        yield* sql`INSERT INTO projection_usage_codex_retired_turns VALUES (${row.thread_id}, ${turnId}) ON CONFLICT DO NOTHING`;
      }
      yield* sql`UPDATE projection_usage_codex_state SET state_json = ${JSON.stringify(state)} WHERE thread_id = ${row.thread_id}`;
    }
    after = rows.at(-1)!.thread_id;
  }
});
