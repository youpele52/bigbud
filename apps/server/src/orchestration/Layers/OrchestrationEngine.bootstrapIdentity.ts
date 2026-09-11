import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Effect, Option, Schema } from "effect";

import { calculateCommandPayloadDigest, canonicalizeCommandPayload } from "../commandDigest.ts";
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
} from "../Errors.ts";
import type {
  OrchestrationBootstrapRecipeRepositoryShape,
  OrchestrationBootstrapSubmissionRecipe,
} from "../../persistence/Services/OrchestrationBootstrapRecipes.ts";

type SubmissionCommand = Extract<OrchestrationCommand, { type: "thread.message.submit" }>;

export type BootstrapSubmissionDispatch = {
  readonly originalCommand: SubmissionCommand;
};

function strippedSubmission(command: SubmissionCommand): OrchestrationCommand {
  const { bootstrap: _bootstrap, ...withoutBootstrap } = command;
  return withoutBootstrap;
}

function matchesOriginalSubmission(
  command: SubmissionCommand,
  recipe: OrchestrationBootstrapSubmissionRecipe,
  originalCommand: SubmissionCommand | undefined,
) {
  const digest = calculateCommandPayloadDigest(originalCommand ?? command);
  if (
    digest.version !== recipe.originalPayloadDigestVersion ||
    digest.digest !== recipe.originalPayloadDigest
  ) {
    return false;
  }
  return (
    originalCommand === undefined ||
    canonicalizeCommandPayload(strippedSubmission(originalCommand)) ===
      canonicalizeCommandPayload(command)
  );
}

export function validateBootstrapSubmissionIdentity(input: {
  readonly command: OrchestrationCommand;
  readonly repository: OrchestrationBootstrapRecipeRepositoryShape;
  readonly bootstrapSubmission?: BootstrapSubmissionDispatch;
}) {
  return input.repository.getByParentCommandId(input.command.commandId).pipe(
    Effect.flatMap((existing) => {
      if (Option.isNone(existing) || existing.value.recipeVersion !== "bootstrap-submission/v1") {
        return Effect.void;
      }
      const recipe = existing.value;
      if (
        input.command.type === "thread.message.submit" &&
        matchesOriginalSubmission(input.command, recipe, input.bootstrapSubmission?.originalCommand)
      ) {
        return Effect.void;
      }
      const actualDigest = calculateCommandPayloadDigest(input.command);
      return Effect.fail(
        new OrchestrationCommandIdConflictError({
          commandId: input.command.commandId,
          payloadDigestVersion: actualDigest.version,
          payloadDigest: actualDigest.digest,
          storedPayloadDigestVersion: recipe.originalPayloadDigestVersion,
          storedPayloadDigest: recipe.originalPayloadDigest,
        }),
      );
    }),
    Effect.mapError((error) =>
      Schema.is(OrchestrationCommandIdConflictError)(error)
        ? error
        : new OrchestrationCommandInvariantError({
            commandType: input.command.type,
            detail: `Unable to verify bootstrap submission identity: ${error instanceof Error ? error.message : "unknown persistence error"}`,
          }),
    ),
  );
}
