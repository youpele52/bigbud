import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const OLD_FINITE_POLICIES = "'7-days', '14-days', '30-days', '90-days'";
const NEW_FINITE_POLICIES =
  "'1-day', '2-days', '3-days', '7-days', '14-days', '30-days', '90-days'";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const schemas = yield* sql<{ name: string; sql: string | null }>`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'thread_retention_consent_challenges',
      'thread_retention_runs',
      'thread_retention_policy_authority'
    )
  `;
  const pending = schemas.filter(
    (row) =>
      row.sql !== null && row.sql.includes(OLD_FINITE_POLICIES) && !row.sql.includes("'1-day'"),
  );
  if (pending.length === 0) return;

  yield* sql`PRAGMA writable_schema = ON`;
  yield* sql.unsafe(`
    UPDATE sqlite_master
    SET sql = replace(
      sql,
      '${OLD_FINITE_POLICIES.replaceAll("'", "''")}',
      '${NEW_FINITE_POLICIES.replaceAll("'", "''")}'
    )
    WHERE type = 'table'
      AND name IN (
        'thread_retention_consent_challenges',
        'thread_retention_runs',
        'thread_retention_policy_authority'
      )
  `);
  yield* sql`PRAGMA writable_schema = RESET`;
});
