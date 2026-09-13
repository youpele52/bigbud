import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";
import { runMigrations } from "../Migrations.ts";
import { rebuildTableSql } from "./MigrationTableRebuild.ts";

export const oldAt = "2026-08-01T00:00:00.000Z";

export const seedLegacyRetentionSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 116 });
  yield* sql.withTransaction(
    rebuildTableSql(sql, "thread_retention_run_items", (ddl) =>
      ddl.replace(
        /\)\s*$/,
        ", FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE)",
      ),
    ),
  );
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('retention-project', 'Retention', '/tmp/retention', '[]', ${oldAt}, ${oldAt})
  `;
});

export const seedLegacyRetentionRun = Effect.fn("seedLegacyRetentionRun")(function* (
  runId: string,
  status: "selecting" | "preparing" | "purging" | "queued" = "selecting",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO thread_retention_runs (
      run_id, trigger_kind, policy, cutoff_at, status, active_slot, created_at, updated_at
    ) VALUES (${runId}, 'manual', '7-days', '2026-08-10T00:00:00.000Z', ${status},
      ${status === "queued" ? null : 1}, ${oldAt}, ${oldAt})
  `;
});

export const seedLegacyRetentionItem = Effect.fn("seedLegacyRetentionItem")(function* (
  runId: string,
  threadId: string,
  status: "selected" | "deletion_requested" = "selected",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* insertProjectionThreadParent({
    sql,
    threadId: ThreadId.makeUnsafe(threadId),
    projectId: "retention-project",
    createdAt: oldAt,
  });
  yield* sql`
    INSERT INTO thread_retention_run_items (
      run_id, thread_id, expected_last_activity_at, deletion_command_id, status, created_at, updated_at
    ) VALUES (${runId}, ${threadId}, ${oldAt}, ${`delete:${threadId}`}, ${status}, ${oldAt}, ${oldAt})
  `;
  yield* sql`UPDATE thread_retention_runs SET selected_count = selected_count + 1,
    requested_count = requested_count + ${status === "deletion_requested" ? 1 : 0}
    WHERE run_id = ${runId}`;
});
