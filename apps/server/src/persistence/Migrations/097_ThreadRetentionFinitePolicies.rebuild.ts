import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const OLD_FINITE_POLICIES = "'7-days', '14-days', '30-days', '90-days'";
const NEW_FINITE_POLICIES =
  "'1-day', '2-days', '3-days', '7-days', '14-days', '30-days', '90-days'";

interface SchemaObject {
  readonly name: string;
  readonly sql: string | null;
}

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const readTableSql = Effect.fn("readTableSql")(function* (sql: SqlClient.SqlClient, table: string) {
  const rows = yield* sql<{ sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `;
  return rows[0]?.sql ?? null;
});

const readDependentObjects = Effect.fn("readDependentObjects")(function* (
  sql: SqlClient.SqlClient,
  table: string,
) {
  return yield* sql<SchemaObject>`
    SELECT name, sql FROM sqlite_master
    WHERE tbl_name = ${table}
      AND (
        (type = 'index' AND sql IS NOT NULL)
        OR type = 'trigger'
      )
    ORDER BY type, name
  `;
});

const readReferencingTriggers = Effect.fn("readReferencingTriggers")(function* (
  sql: SqlClient.SqlClient,
  table: string,
) {
  return yield* sql<SchemaObject>`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger'
      AND sql LIKE ${`%${table}%`}
      AND tbl_name != ${table}
    ORDER BY name
  `;
});

const recreateObjects = Effect.fn("recreateObjects")(function* (
  sql: SqlClient.SqlClient,
  objects: ReadonlyArray<SchemaObject>,
) {
  for (const object of objects) {
    if (object.sql === null) continue;
    yield* sql.unsafe(object.sql);
  }
});

const copyTableRows = Effect.fn("copyTableRows")(function* (
  sql: SqlClient.SqlClient,
  from: string,
  to: string,
) {
  yield* sql.unsafe(`INSERT INTO ${quoteIdent(to)} SELECT * FROM ${quoteIdent(from)}`);
});

export const rebuildPolicyCheckTable = Effect.fn("rebuildPolicyCheckTable")(function* (
  sql: SqlClient.SqlClient,
  table: string,
  options?: { readonly children?: ReadonlyArray<string> },
) {
  const tableSql = yield* readTableSql(sql, table);
  if (
    tableSql === null ||
    !tableSql.includes(OLD_FINITE_POLICIES) ||
    tableSql.includes("'1-day'")
  ) {
    return;
  }

  const children = options?.children ?? [];
  const referencingTriggers: SchemaObject[] = [];
  const seenTriggerNames = new Set<string>();
  for (const child of children) {
    const triggers = yield* readReferencingTriggers(sql, child);
    for (const trigger of triggers) {
      if (seenTriggerNames.has(trigger.name)) continue;
      seenTriggerNames.add(trigger.name);
      referencingTriggers.push(trigger);
    }
  }
  for (const trigger of referencingTriggers) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${quoteIdent(trigger.name)}`);
  }

  const childSnapshots = yield* Effect.forEach(children, (child) =>
    Effect.gen(function* () {
      const childSql = yield* readTableSql(sql, child);
      const objects = yield* readDependentObjects(sql, child);
      const backup = `${child}__097_bak`;
      yield* sql.unsafe(`CREATE TABLE ${quoteIdent(backup)} AS SELECT * FROM ${quoteIdent(child)}`);
      return { child, childSql, objects, backup };
    }),
  );

  for (const snapshot of [...childSnapshots].toReversed()) {
    yield* sql.unsafe(`DROP TABLE ${quoteIdent(snapshot.child)}`);
  }

  const objects = yield* readDependentObjects(sql, table);
  const nextTable = `${table}__097_next`;
  const nextSql = tableSql
    .replace(OLD_FINITE_POLICIES, NEW_FINITE_POLICIES)
    .replace(
      new RegExp(`CREATE TABLE ["']?${table}["']?`),
      `CREATE TABLE ${quoteIdent(nextTable)}`,
    );
  yield* sql.unsafe(nextSql);
  yield* copyTableRows(sql, table, nextTable);
  yield* sql.unsafe(`DROP TABLE ${quoteIdent(table)}`);
  yield* sql.unsafe(`ALTER TABLE ${quoteIdent(nextTable)} RENAME TO ${quoteIdent(table)}`);
  yield* recreateObjects(sql, objects);

  for (const snapshot of childSnapshots) {
    if (snapshot.childSql === null) {
      return yield* Effect.die(new Error(`missing DDL for ${snapshot.child}`));
    }
    yield* sql.unsafe(snapshot.childSql);
    yield* recreateObjects(sql, snapshot.objects);
    yield* copyTableRows(sql, snapshot.backup, snapshot.child);
    yield* sql.unsafe(`DROP TABLE ${quoteIdent(snapshot.backup)}`);
  }
  yield* recreateObjects(sql, referencingTriggers);
});
