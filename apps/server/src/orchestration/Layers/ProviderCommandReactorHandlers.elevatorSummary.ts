import type { MetadataSummaryRequest } from "./ThreadMetadataGeneration.requests.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

export {
  buildElevatorSummaryTranscript,
  countVisibleSummaryMessages,
  shouldRefreshThreadElevatorSummary,
} from "./ThreadMetadataGeneration.summaryInput.ts";

/** Queue an immutable summary job; persistence and retries belong to the durable coordinator. */
export const maybeGenerateThreadElevatorSummary = (services: SessionOpServices) =>
  Effect.fn("maybeGenerateThreadElevatorSummary")(function* (input: MetadataSummaryRequest) {
    if (!services.metadataGeneration) {
      yield* Effect.logWarning("Durable metadata generation is unavailable.");
      return;
    }
    yield* services.metadataGeneration
      .summary(input)
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not confirm durable summary generation request."),
        ),
      );
  });
