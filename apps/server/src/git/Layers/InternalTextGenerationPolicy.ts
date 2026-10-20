import { Equal, Effect } from "effect";
import { TextGenerationError, type ModelSelection } from "@bigbud/contracts";

/** Produces at most two distinct, explicitly authorized provider/model pairs. */
export function internalTextGenerationCandidates(
  preference: ModelSelection | null,
  successful: ModelSelection | null | undefined,
): ReadonlyArray<ModelSelection> {
  const candidates = [preference, successful].filter(
    (selection): selection is ModelSelection => selection != null,
  );
  return candidates.filter(
    (selection, index) =>
      !candidates
        .slice(0, index)
        .some(
          (previous) =>
            previous.provider === selection.provider &&
            previous.model === selection.model &&
            Equal.equals(
              "subProviderID" in previous ? previous.subProviderID : undefined,
              "subProviderID" in selection ? selection.subProviderID : undefined,
            ),
        ),
  );
}

/** Typed failures may fall through once; interruption and defects never retry. */
export function runInternalTextGeneration<A>(input: {
  readonly operation: string;
  readonly preference: ModelSelection | null;
  readonly successful?: ModelSelection | null;
  readonly generate: (selection: ModelSelection) => Effect.Effect<A, TextGenerationError>;
}): Effect.Effect<A, TextGenerationError> {
  const candidates = internalTextGenerationCandidates(input.preference, input.successful);
  const attempt = (index: number): Effect.Effect<A, TextGenerationError> => {
    const selection = candidates[index];
    if (!selection) {
      return Effect.fail(
        new TextGenerationError({
          operation: input.operation,
          detail: "No explicit text-generation preference or successful thread model is available.",
        }),
      );
    }
    return input.generate(selection).pipe(
      Effect.catch((error) =>
        Effect.logWarning("internal text generation attempt failed", {
          operation: input.operation,
          provider: selection.provider,
          model: selection.model,
          attempt: index + 1,
          detail: error.detail,
        }).pipe(
          Effect.andThen(
            // Invalid inputs cannot become valid by charging another provider.
            index + 1 < candidates.length &&
              error.kind !== "invalid-input" &&
              error.kind !== "cancelled" &&
              error.kind !== "uncertain" &&
              !/invalid input|empty (?:message|transcript)|must provide|cancel(?:led|ed|lation)|abort(?:ed)?/i.test(
                error.detail,
              )
              ? attempt(index + 1)
              : Effect.fail(error),
          ),
        ),
      ),
    );
  };
  return attempt(0);
}
