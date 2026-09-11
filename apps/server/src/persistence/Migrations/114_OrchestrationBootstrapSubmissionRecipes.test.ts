import { CommandId, ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationBootstrapRecipeRepositoryLive } from "../Layers/OrchestrationBootstrapRecipes.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { OrchestrationBootstrapRecipeRepository } from "../Services/OrchestrationBootstrapRecipes.ts";

it.layer(
  OrchestrationBootstrapRecipeRepositoryLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
)("114_OrchestrationBootstrapSubmissionRecipes", (it) => {
  it.effect(
    "upgrades legacy SQLite rows and supports durable create-only claims in the same table",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* OrchestrationBootstrapRecipeRepository;
        yield* runMigrations({ toMigrationInclusive: 113 });
        yield* sql`
        INSERT INTO orchestration_bootstrap_recipes (
          parent_command_id, recipe_version, execution_target_id, project_id,
          project_cwd, base_branch, requested_branch, deterministic_worktree_path, created_at
        ) VALUES (
          'legacy-parent', 'bootstrap-worktree/v1', 'local', 'project-1',
          '/repo/project', 'main', NULL, '/worktrees/owned', '2026-08-27T00:00:00.000Z'
        )
      `;
        const migrations = yield* runMigrations();
        assert.deepStrictEqual(migrations, [[114, "OrchestrationBootstrapSubmissionRecipes"]]);
        const columns = yield* sql<{ name: string; notnull: number }>`
        PRAGMA table_info(orchestration_bootstrap_recipes)
      `;
        for (const name of [
          "project_cwd",
          "base_branch",
          "original_payload_digest_version",
          "original_payload_digest",
        ]) {
          assert.equal(columns.find((column) => column.name === name)?.notnull, 0);
        }
        const legacy = {
          parentCommandId: CommandId.makeUnsafe("legacy-parent"),
          recipeVersion: "bootstrap-worktree/v1" as const,
          executionTargetId: "local",
          projectId: ProjectId.makeUnsafe("project-1"),
          projectCwd: "/repo/project",
          baseBranch: "main",
          requestedBranch: null,
          deterministicWorktreePath: "/worktrees/owned",
          createdAt: "2026-08-27T00:00:00.000Z",
        };
        assert.deepStrictEqual(
          yield* repository.getByParentCommandId(legacy.parentCommandId),
          Option.some(legacy),
        );
        assert.deepStrictEqual(yield* repository.claimOrInspect(legacy), {
          status: "existing",
          recipe: legacy,
        });
        const submission = {
          ...legacy,
          parentCommandId: CommandId.makeUnsafe("create-only-parent"),
          recipeVersion: "bootstrap-submission/v1" as const,
          originalPayloadDigestVersion: "command-digest/v1",
          originalPayloadDigest: "original-payload-digest",
          executionTargetId: null,
          projectId: null,
          projectCwd: null,
          baseBranch: null,
          deterministicWorktreePath: null,
        };
        yield* repository.claimOrInspect(submission);
        assert.deepStrictEqual(yield* repository.claimOrInspect(submission), {
          status: "existing",
          recipe: submission,
        });
        assert.deepStrictEqual(
          yield* repository.claimOrInspect({ ...submission, originalPayloadDigest: "changed" }),
          { status: "conflict", recipe: submission },
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(
          yield* repository.getByParentCommandId(submission.parentCommandId),
          Option.some(submission),
        );
        assert.deepStrictEqual(
          yield* sql`
          SELECT parent_command_id, original_payload_digest_version, original_payload_digest
          FROM orchestration_bootstrap_recipes ORDER BY parent_command_id
        `,
          [
            {
              parent_command_id: "create-only-parent",
              original_payload_digest_version: "command-digest/v1",
              original_payload_digest: "original-payload-digest",
            },
            {
              parent_command_id: "legacy-parent",
              original_payload_digest_version: null,
              original_payload_digest: null,
            },
          ],
        );
      }),
  );
});
