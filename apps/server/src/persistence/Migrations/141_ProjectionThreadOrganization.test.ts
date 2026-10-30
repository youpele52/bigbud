import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./141_ProjectionThreadOrganization.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("141_ProjectionThreadOrganization", (it) => {
  it.effect("adds organization columns idempotently with Present defaults for existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 140 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, branch,
          worktree_path, latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES (
          'legacy-thread', 'project', 'Legacy', '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* migration;
      yield* migration;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = columns.map((column) => column.name);
      for (const name of [
        "organization_state",
        "organization_revision",
        "organization_changed_at",
        "organization_snooze_id",
        "organization_snooze_until",
      ]) {
        assert.equal(names.filter((entry) => entry === name).length, 1);
      }
      const rows = yield* sql<{
        readonly state: string;
        readonly revision: number;
        readonly snoozeId: string | null;
      }>`
        SELECT organization_state AS "state", organization_revision AS "revision",
          organization_snooze_id AS "snoozeId"
        FROM projection_threads WHERE thread_id = 'legacy-thread'
      `;
      assert.deepStrictEqual(rows, [{ state: "present", revision: 0, snoozeId: null }]);
    }),
  );
});
