import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Effect, Option } from "effect";

import { calculateCommandPayloadDigest } from "../orchestration/commandDigest.ts";
import type {
  OrchestrationBootstrapSubmissionRecipe,
  OrchestrationBootstrapRecipeRepositoryShape,
} from "../persistence/Services/OrchestrationBootstrapRecipes.ts";

export type BootstrapSubmissionRecipe = OrchestrationBootstrapSubmissionRecipe;
type SubmissionCommand = Extract<OrchestrationCommand, { type: "thread.message.submit" }>;

export function findMatchingBootstrapSubmissionRecipe(input: {
  readonly command: SubmissionCommand;
  readonly repository: OrchestrationBootstrapRecipeRepositoryShape;
}) {
  return Effect.gen(function* () {
    const existing = yield* input.repository.getByParentCommandId(input.command.commandId);
    if (Option.isNone(existing)) return Option.none<BootstrapSubmissionRecipe>();
    const recipe = existing.value;
    const digest = calculateCommandPayloadDigest(input.command);
    if (
      recipe.recipeVersion === "bootstrap-submission/v1" &&
      recipe.originalPayloadDigestVersion === digest.version &&
      recipe.originalPayloadDigest === digest.digest
    ) {
      return Option.some(recipe);
    }
    return yield* new OrchestrationDispatchCommandError({
      message: "Bootstrap submission conflicts with its original payload.",
      code: "command_id_conflict",
    });
  });
}

export function claimBootstrapSubmissionRecipe<E>(input: {
  readonly command: SubmissionCommand;
  readonly repository: OrchestrationBootstrapRecipeRepositoryShape | undefined;
  readonly requireExisting: boolean;
  readonly resolveRecipe: () => Effect.Effect<
    Omit<
      BootstrapSubmissionRecipe,
      | "parentCommandId"
      | "recipeVersion"
      | "originalPayloadDigestVersion"
      | "originalPayloadDigest"
      | "createdAt"
    >,
    E
  >;
}) {
  return Effect.gen(function* () {
    if (!input.repository) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Durable bootstrap submission recipes are unavailable.",
      });
    }
    const existing = yield* findMatchingBootstrapSubmissionRecipe({
      command: input.command,
      repository: input.repository,
    });
    if (Option.isSome(existing)) return existing.value;
    if (input.requireExisting) {
      return yield* new OrchestrationDispatchCommandError({
        message:
          "Bootstrap submission receipt has no matching original recipe; identity cannot be verified.",
        code: "command_id_conflict",
      });
    }
    const resolved = yield* input.resolveRecipe();
    if (
      input.command.bootstrap?.prepareWorktree &&
      !resolved.requestedBranch &&
      !resolved.deterministicWorktreePath
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Bootstrap worktree recipe lacks deterministic physical identity.",
      });
    }
    const digest = calculateCommandPayloadDigest(input.command);
    const recipe = {
      ...resolved,
      parentCommandId: input.command.commandId,
      recipeVersion: "bootstrap-submission/v1" as const,
      originalPayloadDigestVersion: digest.version,
      originalPayloadDigest: digest.digest,
      createdAt: input.command.createdAt,
    };
    const claimed = yield* input.repository.claimOrInspect(recipe);
    if (claimed.status === "conflict") {
      return yield* new OrchestrationDispatchCommandError({
        message: "Bootstrap submission recipe conflicts with prior claim.",
        code: "command_id_conflict",
      });
    }
    return recipe;
  });
}
