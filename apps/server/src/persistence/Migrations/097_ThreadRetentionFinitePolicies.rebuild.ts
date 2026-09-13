import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { rebuildTableSql } from "./MigrationTableRebuild.ts";

// Match both the original schema and the intermediate release that omitted 3-days.
const OLD_FINITE_POLICIES =
  /(?:'1-day'\s*,\s*)?(?:'2-days'\s*,\s*)?'7-days'\s*,\s*'14-days'\s*,\s*'30-days'\s*,\s*'90-days'/;
const NEW_FINITE_POLICIES =
  "'1-day', '2-days', '3-days', '7-days', '14-days', '30-days', '90-days'";

export const rebuildPolicyCheckTable = Effect.fn("rebuildPolicyCheckTable")(function* (
  sql: SqlClient.SqlClient,
  table: string,
  options?: { readonly children?: ReadonlyArray<string> },
) {
  yield* rebuildTableSql(
    sql,
    table,
    (tableSql) =>
      tableSql.includes("'3-days'")
        ? tableSql
        : tableSql.replace(OLD_FINITE_POLICIES, NEW_FINITE_POLICIES),
    options,
  );
});
