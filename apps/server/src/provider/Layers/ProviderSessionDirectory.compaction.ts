import { Effect, Schema } from "effect";
import { CodexCompactionConfirmation } from "../Services/ProviderCompaction.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderSessionRuntimeRepositoryShape } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError } from "../Errors.ts";

/** Acknowledgment is withheld when the durable proof cannot be recorded for this exact owner. */
export function makeDirectoryCompaction(
  repository: ProviderSessionRuntimeRepositoryShape,
): Pick<ProviderSessionDirectoryShape, "recordCodexCompaction"> {
  const failure = (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.recordCodexCompaction",
      detail: "Manual compaction proof persistence failed; completion was not acknowledged.",
      cause,
    });
  return {
    recordCodexCompaction: (input) =>
      Effect.gen(function* () {
        const proof = yield* Schema.decodeUnknownEffect(CodexCompactionConfirmation)(input).pipe(
          Effect.mapError(failure),
        );
        if (!repository.recordCodexCompaction)
          return yield* failure("Atomic proof storage is unavailable.");
        const stored = yield* repository
          .recordCodexCompaction(proof)
          .pipe(Effect.mapError(failure));
        if (!stored)
          return yield* failure("The native owner/epoch changed or proof identity conflicts.");
      }),
  };
}
