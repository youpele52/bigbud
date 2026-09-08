import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "107_OrchestrationBootstrapRecipes",
  (it) => {
    it.effect("creates durable bootstrap recipe storage", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`
          INSERT INTO orchestration_bootstrap_recipes (
            parent_command_id, recipe_version, execution_target_id, project_id,
            project_cwd, base_branch, requested_branch, deterministic_worktree_path, created_at
          ) VALUES (
            'cmd-bootstrap-recipe', 'bootstrap-worktree/v1', 'local', 'project-1',
            '/repo/project', 'main', NULL, '/worktrees/owned',
            '2026-08-27T00:00:00.000Z'
          )
        `;

        assert.deepEqual(
          yield* sql`
            SELECT deterministic_worktree_path AS "path"
            FROM orchestration_bootstrap_recipes
            WHERE parent_command_id = 'cmd-bootstrap-recipe'
          `,
          [{ path: "/worktrees/owned" }],
        );
      }),
    );
  },
);
