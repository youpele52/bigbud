import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";
import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  OrchestrationBootstrapRecipe,
  OrchestrationBootstrapRecipeRepository,
  type BootstrapRecipeClaimResult,
  type OrchestrationBootstrapRecipeRepositoryShape,
} from "../Services/OrchestrationBootstrapRecipes.ts";

function sameRecipe(a: OrchestrationBootstrapRecipe, b: OrchestrationBootstrapRecipe) {
  return (
    a.recipeVersion === b.recipeVersion &&
    a.executionTargetId === b.executionTargetId &&
    a.projectId === b.projectId &&
    a.projectCwd === b.projectCwd &&
    a.baseBranch === b.baseBranch &&
    a.requestedBranch === b.requestedBranch &&
    a.deterministicWorktreePath === b.deterministicWorktreePath
  );
}

const makeOrchestrationBootstrapRecipeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByParentCommandId = SqlSchema.findOneOption({
    Request: Schema.Struct({ parentCommandId: CommandId }),
    Result: OrchestrationBootstrapRecipe,
    execute: ({ parentCommandId }) =>
      sql`
        SELECT
          parent_command_id AS "parentCommandId",
          recipe_version AS "recipeVersion",
          execution_target_id AS "executionTargetId",
          project_id AS "projectId",
          project_cwd AS "projectCwd",
          base_branch AS "baseBranch",
          requested_branch AS "requestedBranch",
          deterministic_worktree_path AS "deterministicWorktreePath",
          created_at AS "createdAt"
        FROM orchestration_bootstrap_recipes
        WHERE parent_command_id = ${parentCommandId}
      `,
  });

  const insertRecipe = SqlSchema.void({
    Request: OrchestrationBootstrapRecipe,
    execute: (recipe) =>
      sql`
        INSERT INTO orchestration_bootstrap_recipes (
          parent_command_id,
          recipe_version,
          execution_target_id,
          project_id,
          project_cwd,
          base_branch,
          requested_branch,
          deterministic_worktree_path,
          created_at
        )
        VALUES (
          ${recipe.parentCommandId},
          ${recipe.recipeVersion},
          ${recipe.executionTargetId},
          ${recipe.projectId},
          ${recipe.projectCwd},
          ${recipe.baseBranch},
          ${recipe.requestedBranch},
          ${recipe.deterministicWorktreePath},
          ${recipe.createdAt}
        )
        ON CONFLICT(parent_command_id) DO NOTHING
      `,
  });

  const getByParentCommandId: OrchestrationBootstrapRecipeRepositoryShape["getByParentCommandId"] =
    (parentCommandId) =>
      findByParentCommandId({ parentCommandId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationBootstrapRecipeRepository.getByParentCommandId"),
        ),
      );

  const claimOrInspect: OrchestrationBootstrapRecipeRepositoryShape["claimOrInspect"] = (recipe) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* insertRecipe(recipe);
          const existing = yield* findByParentCommandId({
            parentCommandId: recipe.parentCommandId,
          });
          if (Option.isNone(existing)) return { status: "claimed", recipe } as const;
          const status = sameRecipe(existing.value, recipe) ? "existing" : "conflict";
          return { status, recipe: existing.value } satisfies BootstrapRecipeClaimResult;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationBootstrapRecipeRepository.claimOrInspect"),
        ),
      );

  return {
    claimOrInspect,
    getByParentCommandId,
  } satisfies OrchestrationBootstrapRecipeRepositoryShape;
});

export const OrchestrationBootstrapRecipeRepositoryLive = Layer.effect(
  OrchestrationBootstrapRecipeRepository,
  makeOrchestrationBootstrapRecipeRepository,
);
