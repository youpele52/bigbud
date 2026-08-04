import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_retention_policy_authority (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      policy TEXT NOT NULL CHECK (policy IN ('7-days', '14-days', '30-days', '90-days', 'never')),
      source TEXT NOT NULL CHECK (source IN ('explicit', 'rollout-automatic', 'rollout-protected', 'rollout-staged')),
      updated_at TEXT NOT NULL
    )
  `;
});
