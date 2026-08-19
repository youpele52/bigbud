import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const OLD_FINITE_POLICIES = "'7-days', '14-days', '30-days', '90-days'";
const NEW_FINITE_POLICIES =
  "'1-day', '2-days', '3-days', '7-days', '14-days', '30-days', '90-days'";

const rewriteRetentionPolicyCheck = Effect.fn("rewriteRetentionPolicyCheck")(function* (
  sql: SqlClient.SqlClient,
  table: string,
) {
  const create = yield* sql<{ sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `;
  const ddl = create[0]?.sql;
  if (ddl === undefined || ddl === null || ddl.includes("'1-day'")) return;
  if (!ddl.includes(OLD_FINITE_POLICIES)) {
    return yield* Effect.die(new Error(`thread retention policy check was not found on ${table}`));
  }
  const artifacts = yield* sql<{ sql: string | null }>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = ${table} AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `;
  const nextDdl = ddl
    .replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_next`)
    .replace(OLD_FINITE_POLICIES, NEW_FINITE_POLICIES);
  yield* sql.unsafe(nextDdl);
  yield* sql.unsafe(`INSERT INTO ${table}_next SELECT * FROM ${table}`);
  yield* sql.unsafe(`DROP TABLE ${table}`);
  yield* sql.unsafe(`ALTER TABLE ${table}_next RENAME TO ${table}`);
  for (const artifact of artifacts) {
    if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
  }
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = OFF`;
  yield* rewriteRetentionPolicyCheck(sql, "thread_retention_consent_challenges");
  yield* rewriteRetentionPolicyCheck(sql, "thread_retention_runs");
  yield* rewriteRetentionPolicyCheck(sql, "thread_retention_policy_authority");
  yield* sql`PRAGMA foreign_keys = ON`;
});
