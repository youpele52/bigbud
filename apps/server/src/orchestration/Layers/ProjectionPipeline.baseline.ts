import { Effect, Option } from "effect";

import { type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { OrchestrationEventStoreShape } from "../../persistence/Services/OrchestrationEventStore.ts";
import type {
  ProjectionBaseline,
  ProjectionBaselineRepositoryShape,
} from "../../persistence/Services/ProjectionBaselines.ts";

export function makeProjectionBaselineOperations(input: {
  readonly eventStore: OrchestrationEventStoreShape;
  readonly baselines: ProjectionBaselineRepositoryShape;
  readonly projectorNames: ReadonlyArray<string>;
  readonly verifyCandidate: (
    candidate: ProjectionBaseline,
    source: Option.Option<ProjectionBaseline>,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}) {
  const verify = Effect.fn("verifyProjectionBaseline")(function* (candidate: ProjectionBaseline) {
    if (candidate.verificationStatus === "verified") return true;
    const previousOption = yield* input.baselines.latestVerified();
    const previous = Option.getOrUndefined(previousOption);
    if (previous && previous.sequence >= candidate.sequence) return false;

    const matches = yield* input.verifyCandidate(candidate, previousOption);
    if (!matches) {
      yield* input.baselines.markRejected(
        candidate.baselineId,
        `normalized replay hash mismatch: expected ${candidate.payloadHash}`,
      );
      return false;
    }
    yield* input.baselines.markVerified(
      candidate.baselineId,
      candidate.sequence,
      new Date().toISOString(),
    );
    return true;
  });

  const compact = Effect.fn("compactCanonicalProjectionEvents")(function* (batchSize = 500) {
    const candidateOption = yield* input.baselines.createCandidate(input.projectorNames);
    if (Option.isNone(candidateOption)) return;
    const verified = yield* verify(candidateOption.value);
    if (!verified) return;
    if (input.eventStore.compactVerifiedPrefix) {
      yield* input.eventStore.compactVerifiedPrefix(batchSize);
    }
  });

  return { compact, verify };
}
