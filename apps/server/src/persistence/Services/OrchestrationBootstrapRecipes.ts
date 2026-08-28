import { CommandId, IsoDateTime, ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors.ts";

export const BootstrapRecipeVersion = Schema.Literal("bootstrap-worktree/v1");
export type BootstrapRecipeVersion = typeof BootstrapRecipeVersion.Type;

export const OrchestrationBootstrapRecipe = Schema.Struct({
  parentCommandId: CommandId,
  recipeVersion: BootstrapRecipeVersion,
  executionTargetId: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  projectCwd: Schema.String,
  baseBranch: Schema.String,
  requestedBranch: Schema.NullOr(Schema.String),
  deterministicWorktreePath: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type OrchestrationBootstrapRecipe = typeof OrchestrationBootstrapRecipe.Type;

export type BootstrapRecipeClaimResult =
  | { readonly status: "claimed"; readonly recipe: OrchestrationBootstrapRecipe }
  | { readonly status: "existing"; readonly recipe: OrchestrationBootstrapRecipe }
  | { readonly status: "conflict"; readonly recipe: OrchestrationBootstrapRecipe };

export interface OrchestrationBootstrapRecipeRepositoryShape {
  readonly claimOrInspect: (
    recipe: OrchestrationBootstrapRecipe,
  ) => Effect.Effect<BootstrapRecipeClaimResult, OrchestrationCommandReceiptRepositoryError>;
  readonly getByParentCommandId: (
    parentCommandId: CommandId,
  ) => Effect.Effect<
    Option.Option<OrchestrationBootstrapRecipe>,
    OrchestrationCommandReceiptRepositoryError
  >;
}

export class OrchestrationBootstrapRecipeRepository extends ServiceMap.Service<
  OrchestrationBootstrapRecipeRepository,
  OrchestrationBootstrapRecipeRepositoryShape
>()("bigbud/persistence/Services/OrchestrationBootstrapRecipes") {}
