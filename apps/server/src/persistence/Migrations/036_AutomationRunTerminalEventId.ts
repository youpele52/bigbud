import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(automation_runs)
  `;

  if (!runColumns.some((column) => column.name === "provider_terminal_event_id")) {
    yield* sql`
      ALTER TABLE automation_runs
      ADD COLUMN provider_terminal_event_id TEXT
    `;
  }
});
