import { CommandId, IsoDateTime, ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors.ts";

export const BootstrapRecipeVersion = Schema.Literals([
  "bootstrap-worktree/v1",
  "bootstrap-submission/v1",
]);
export type BootstrapRecipeVersion = typeof BootstrapRecipeVersion.Type;

const bootstrapRecipeFields = {
  parentCommandId: CommandId,
  executionTargetId: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  requestedBranch: Schema.NullOr(Schema.String),
  deterministicWorktreePath: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
};

export const OrchestrationBootstrapWorktreeRecipe = Schema.Struct({
  ...bootstrapRecipeFields,
  recipeVersion: Schema.Literal("bootstrap-worktree/v1"),
  projectCwd: Schema.String,
  baseBranch: Schema.String,
});
export type OrchestrationBootstrapWorktreeRecipe = typeof OrchestrationBootstrapWorktreeRecipe.Type;

export const OrchestrationBootstrapSubmissionRecipe = Schema.Struct({
  ...bootstrapRecipeFields,
  recipeVersion: Schema.Literal("bootstrap-submission/v1"),
  originalPayloadDigestVersion: Schema.String,
  originalPayloadDigest: Schema.String,
  projectCwd: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
});
export type OrchestrationBootstrapSubmissionRecipe =
  typeof OrchestrationBootstrapSubmissionRecipe.Type;

export const OrchestrationBootstrapRecipe = Schema.Union([
  OrchestrationBootstrapWorktreeRecipe,
  OrchestrationBootstrapSubmissionRecipe,
]);
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
