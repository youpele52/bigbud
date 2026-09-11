import { CommandId, ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  OrchestrationBootstrapRecipe,
  OrchestrationBootstrapRecipeRepository,
} from "../Services/OrchestrationBootstrapRecipes.ts";
import { OrchestrationBootstrapRecipeRepositoryLive } from "./OrchestrationBootstrapRecipes.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const legacyRecipe = {
  parentCommandId: CommandId.makeUnsafe("cmd-bootstrap-recipe"),
  recipeVersion: "bootstrap-worktree/v1" as const,
  executionTargetId: "local",
  projectId: ProjectId.makeUnsafe("project-bootstrap-recipe"),
  projectCwd: "/repo/project",
  baseBranch: "main",
  requestedBranch: null,
  deterministicWorktreePath: "/worktrees/command-owned",
  createdAt: "2026-08-27T00:00:00.000Z",
};
const submissionRecipe = {
  ...legacyRecipe,
  parentCommandId: CommandId.makeUnsafe("cmd-bootstrap-submission"),
  recipeVersion: "bootstrap-submission/v1" as const,
  originalPayloadDigestVersion: "command-digest/v1",
  originalPayloadDigest: "original-payload-digest",
};

it("requires physical strings for legacy recipes and original digests for submissions", () => {
  const isRecipe = Schema.is(OrchestrationBootstrapRecipe);
  assert.isTrue(isRecipe(legacyRecipe));
  assert.isFalse(isRecipe({ ...legacyRecipe, projectCwd: null }));
  assert.isFalse(isRecipe({ ...legacyRecipe, baseBranch: null }));
  assert.isTrue(isRecipe(submissionRecipe));
  assert.isTrue(isRecipe({ ...submissionRecipe, projectCwd: null, baseBranch: null }));
  for (const field of ["originalPayloadDigestVersion", "originalPayloadDigest"] as const) {
    const missing: Record<string, unknown> = { ...submissionRecipe };
    delete missing[field];
    assert.isFalse(isRecipe(missing));
    assert.isFalse(isRecipe({ ...submissionRecipe, [field]: null }));
  }
});

const layer = it.layer(
  OrchestrationBootstrapRecipeRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationBootstrapRecipeRepository", (it) => {
  it.effect("preserves legacy claims, replay and conflicts without adding digest properties", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationBootstrapRecipeRepository;
      assert.equal((yield* repository.claimOrInspect(legacyRecipe)).status, "existing");
      assert.deepStrictEqual(yield* repository.claimOrInspect(legacyRecipe), {
        status: "existing",
        recipe: legacyRecipe,
      });
      assert.equal(
        (yield* repository.claimOrInspect({ ...legacyRecipe, baseBranch: "changed" })).status,
        "conflict",
      );
      assert.deepStrictEqual(
        yield* repository.getByParentCommandId(legacyRecipe.parentCommandId),
        Option.some(legacyRecipe),
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`
          SELECT original_payload_digest_version, original_payload_digest
          FROM orchestration_bootstrap_recipes
          WHERE parent_command_id = ${legacyRecipe.parentCommandId}
        `,
        [{ original_payload_digest_version: null, original_payload_digest: null }],
      );
    }),
  );

  it.effect(
    "persists the full resolved submission before replay and ignores retry timestamps",
    () =>
      Effect.gen(function* () {
        const repository = yield* OrchestrationBootstrapRecipeRepository;
        assert.deepStrictEqual(yield* repository.claimOrInspect(submissionRecipe), {
          status: "existing",
          recipe: submissionRecipe,
        });
        assert.deepStrictEqual(
          yield* repository.claimOrInspect({
            ...submissionRecipe,
            createdAt: "2026-08-28T00:00:00.000Z",
          }),
          { status: "existing", recipe: submissionRecipe },
        );
        assert.deepStrictEqual(
          yield* repository.getByParentCommandId(submissionRecipe.parentCommandId),
          Option.some(submissionRecipe),
        );
      }),
  );

  it.effect(
    "rejects changed digests, variants and resolved physical identity without overwriting",
    () =>
      Effect.gen(function* () {
        const repository = yield* OrchestrationBootstrapRecipeRepository;
        const recipe = {
          ...submissionRecipe,
          parentCommandId: CommandId.makeUnsafe("cmd-bootstrap-submission-conflicts"),
        };
        yield* repository.claimOrInspect(recipe);
        const conflicts: OrchestrationBootstrapRecipe[] = [
          { ...recipe, originalPayloadDigestVersion: "command-digest/v2" },
          { ...recipe, originalPayloadDigest: "different-payload-digest" },
          { ...recipe, executionTargetId: "remote-target" },
          { ...recipe, projectId: ProjectId.makeUnsafe("other-project") },
          { ...recipe, projectCwd: "/different/project" },
          { ...recipe, baseBranch: "different-branch" },
          { ...recipe, requestedBranch: "requested-branch" },
          { ...recipe, deterministicWorktreePath: "/different/worktree" },
          { ...legacyRecipe, parentCommandId: recipe.parentCommandId },
        ];
        for (const conflict of conflicts) {
          assert.deepStrictEqual(yield* repository.claimOrInspect(conflict), {
            status: "conflict",
            recipe,
          });
        }
        assert.deepStrictEqual(
          yield* repository.getByParentCommandId(recipe.parentCommandId),
          Option.some(recipe),
        );
        const legacy = {
          ...legacyRecipe,
          parentCommandId: CommandId.makeUnsafe("cmd-bootstrap-legacy-variant-conflict"),
        };
        yield* repository.claimOrInspect(legacy);
        assert.deepStrictEqual(
          yield* repository.claimOrInspect({
            ...submissionRecipe,
            parentCommandId: legacy.parentCommandId,
          }),
          { status: "conflict", recipe: legacy },
        );
      }),
  );

  it.effect("claims and replays create-only submissions with no physical recipe", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationBootstrapRecipeRepository;
      const recipe = {
        ...submissionRecipe,
        parentCommandId: CommandId.makeUnsafe("cmd-bootstrap-create-only"),
        executionTargetId: null,
        projectId: null,
        projectCwd: null,
        baseBranch: null,
        requestedBranch: null,
        deterministicWorktreePath: null,
      };
      yield* repository.claimOrInspect(recipe);
      assert.deepStrictEqual(yield* repository.claimOrInspect(recipe), {
        status: "existing",
        recipe,
      });
      assert.deepStrictEqual(
        yield* repository.getByParentCommandId(recipe.parentCommandId),
        Option.some(recipe),
      );
      assert.deepStrictEqual(
        yield* repository.claimOrInspect({ ...recipe, projectCwd: "/repo/added-later" }),
        { status: "conflict", recipe },
      );
      assert.deepStrictEqual(
        yield* repository.getByParentCommandId(CommandId.makeUnsafe("unknown-parent-command")),
        Option.none(),
      );
    }),
  );
});
