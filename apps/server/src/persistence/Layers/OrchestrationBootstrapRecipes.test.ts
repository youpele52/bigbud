import { CommandId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { OrchestrationBootstrapRecipeRepository } from "../Services/OrchestrationBootstrapRecipes.ts";
import { OrchestrationBootstrapRecipeRepositoryLive } from "./OrchestrationBootstrapRecipes.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationBootstrapRecipeRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationBootstrapRecipeRepository", (it) => {
  it.effect("claims once and reports conflicts for changed physical identity", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationBootstrapRecipeRepository;
      const recipe = {
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

      assert.equal((yield* repository.claimOrInspect(recipe)).status, "existing");
      assert.equal((yield* repository.claimOrInspect(recipe)).status, "existing");
      assert.equal(
        (yield* repository.claimOrInspect({ ...recipe, baseBranch: "changed" })).status,
        "conflict",
      );
      assert.deepStrictEqual(
        yield* repository.getByParentCommandId(recipe.parentCommandId),
        Option.some(recipe),
      );
    }),
  );
});
