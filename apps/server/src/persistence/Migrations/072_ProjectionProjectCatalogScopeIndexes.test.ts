import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./072_ProjectionProjectCatalogScopeIndexes.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("072_ProjectionProjectCatalogScopeIndexes", (it) => {
  it.effect("creates indexable local and sparse remote catalog indexes idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      yield* migration;
      yield* migration;

      const localPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT project_id FROM projection_projects
        WHERE deleted_at IS NULL AND workspace_execution_target_id = 'local'
        ORDER BY last_used_at DESC, project_id ASC LIMIT 5
      `;
      const remotePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT project_id FROM projection_projects
        WHERE deleted_at IS NULL AND workspace_execution_target_id <> 'local'
        ORDER BY last_used_at DESC, project_id ASC LIMIT 5
      `;

      assert.ok(
        localPlan.some((row) =>
          row.detail.includes("idx_projection_projects_active_local_last_used"),
        ),
      );
      assert.ok(
        remotePlan.some((row) =>
          row.detail.includes("idx_projection_projects_active_remote_last_used"),
        ),
      );
    }),
  );
});
