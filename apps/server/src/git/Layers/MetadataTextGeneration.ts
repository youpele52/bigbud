import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import * as Effect from "effect/Effect";

import type { MetadataTextGenerationAttempt } from "../Services/TextGeneration.ts";
import { sanitizeElevatorSummary } from "../Utils.ts";
import { shouldRetryGeneratedThreadTitle } from "../../orchestration/Layers/ProviderCommandReactorHelpers.ts";

type Operation = "generateThreadTitle" | "generateThreadElevatorSummary";

export function validateMetadataOutput<A extends object>(
  operation: Operation,
  result: A,
  titleSeed?: string,
): Effect.Effect<A, TextGenerationError> {
  const text =
    operation === "generateThreadTitle"
      ? "title" in result && typeof result.title === "string"
        ? result.title.trim()
        : ""
      : "summary" in result && typeof result.summary === "string"
        ? sanitizeElevatorSummary(result.summary)
        : "";
  const unusable =
    !text ||
    (operation === "generateThreadTitle" &&
      shouldRetryGeneratedThreadTitle({
        generatedTitle: text,
        ...(titleSeed !== undefined ? { titleSeed } : {}),
      }));
  return unusable
    ? Effect.fail(
        new TextGenerationError({
          operation,
          detail: "Provider returned unusable output.",
          kind: "provider",
          metadataOutcome: "failed",
        }),
      )
    : Effect.succeed(result);
}

/** One call, with a provider-owned fence immediately before external generation. */
export const runMetadataGenerationAttempt = Effect.fn("runMetadataGenerationAttempt")(function* <
  A extends object,
>(input: {
  readonly operation: Operation;
  readonly attempt: MetadataTextGenerationAttempt;
  readonly titleSeed?: string;
  readonly generate: (
    attempt: MetadataTextGenerationAttempt,
  ) => Effect.Effect<A, TextGenerationError>;
}) {
  const { operation } = input;
  const unavailable = (detail: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail,
        metadataOutcome: "unavailable",
      }),
    );
  const snapshot = {
    ...input.attempt,
    selection: structuredClone(input.attempt.selection),
    providerSettings: structuredClone(input.attempt.providerSettings),
  };
  // Local subprocess runners must never receive a remote workspace directory.
  if (snapshot.executionTarget !== "local")
    return yield* unavailable(
      "This auxiliary runner does not support the captured execution target.",
    );
  if (
    !["codex", "claudeAgent", "cursor", "cliProxy", "opencode", "opencodeV2", "copilot"].includes(
      snapshot.selection.provider,
    )
  )
    return yield* unavailable("This provider has not qualified exact metadata dispatch.");
  if (!snapshot.providerSettings[snapshot.selection.provider].enabled)
    return yield* unavailable("The captured provider is disabled.");

  let fenceStarted = false;
  let dispatched = false;
  const beforeDispatch = Effect.fn("metadata.beforeDispatch")(function* () {
    if (fenceStarted)
      return yield* new TextGenerationError({
        operation,
        detail: "A metadata attempt cannot dispatch twice.",
        metadataOutcome: "uncertain",
      });
    fenceStarted = true;
    yield* snapshot.beforeDispatch();
    dispatched = true;
  });
  return yield* input.generate({ ...snapshot, beforeDispatch }).pipe(
    Effect.flatMap((result) =>
      dispatched
        ? validateMetadataOutput(operation, result, input.titleSeed)
        : unavailable("The provider did not cross the metadata dispatch fence."),
    ),
    Effect.map((result) => ({ ...result, actualModelSelection: snapshot.selection })),
    Effect.catchTag("TextGenerationError", (error) =>
      Effect.fail(
        new TextGenerationError({
          operation,
          // Never attach raw provider output or credential-bearing causes to metadata failures.
          detail: fenceStarted
            ? "Metadata generation did not produce a usable result."
            : "Metadata generation is unavailable before dispatch.",
          metadataOutcome: dispatched
            ? error.metadataOutcome === "failed" || error.metadataOutcome === "cancelled"
              ? error.metadataOutcome
              : "uncertain"
            : fenceStarted && error.metadataOutcome !== "unavailable"
              ? "uncertain"
              : "unavailable",
          ...(error.uncertaintyId ? { uncertaintyId: error.uncertaintyId } : {}),
        }),
      ),
    ),
  );
});
