import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { rebuildTableSql } from "./MigrationTableRebuild.ts";

/** Every table whose rows reference `direct_resource_cleanup_plans(operation_id)`. */
export const DIRECT_CLEANUP_PLAN_CHILD_TABLES = [
  "direct_resource_cleanup_resources",
  "direct_resource_cleanup_proofs",
  "direct_resource_cleanup_attempts",
  "direct_resource_cleanup_worktrees",
  "direct_resource_cleanup_retained_external",
  "direct_resource_cleanup_retained_unverified",
] as const;

/**
 * Linux arm64 hosts (remote backends on aarch64 VPSes) run the same Rust cleanup executor, but
 * migration 108 only admitted plans for darwin/arm64, darwin/x64, linux/x64 and win32/x64, so
 * every deletion there failed while storing its plan. Widen the CHECK; existing rows, child
 * rows, indexes and guard triggers are preserved by the transactional table rebuild.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* rebuildTableSql(
    sql,
    "direct_resource_cleanup_plans",
    (ddl) =>
      ddl.replace(
        /CHECK\s*\(\s*expected_platform\s+IN\s*\([^)]*\)\s*\)/i,
        "CHECK (expected_platform IN ('darwin/arm64', 'darwin/x64', 'linux/arm64', 'linux/x64', 'win32/x64'))",
      ),
    { children: DIRECT_CLEANUP_PLAN_CHILD_TABLES, restoreChildObjectsAfterCopy: true },
  );
});
