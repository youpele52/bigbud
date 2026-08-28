import { CommandId, ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Effect } from "effect";

import type { OrchestrationBootstrapRecipeRepositoryShape } from "../persistence/Services/OrchestrationBootstrapRecipes.ts";

export function claimBootstrapWorktreeRecipe(input: {
  readonly repository: OrchestrationBootstrapRecipeRepositoryShape | undefined;
  readonly parentCommandId: CommandId;
  readonly createdAt: string;
  readonly executionTargetId: string | null;
  readonly projectId: ProjectId | null;
  readonly projectCwd: string;
  readonly baseBranch: string;
  readonly requestedBranch: string | null;
  readonly deterministicWorktreePath: string | null;
}) {
  const recipe = {
    parentCommandId: input.parentCommandId,
    recipeVersion: "bootstrap-worktree/v1" as const,
    executionTargetId: input.executionTargetId,
    projectId: input.projectId,
    projectCwd: input.projectCwd,
    baseBranch: input.baseBranch,
    requestedBranch: input.requestedBranch,
    deterministicWorktreePath: input.deterministicWorktreePath,
    createdAt: input.createdAt,
  };
  return input.repository
    ? input.repository.claimOrInspect(recipe).pipe(
        Effect.flatMap((result) =>
          result.status === "conflict"
            ? Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: "Bootstrap worktree recipe conflicts with prior claim.",
                  code: "command_id_conflict",
                }),
              )
            : Effect.succeed(result.recipe),
        ),
      )
    : Effect.succeed(recipe);
}
