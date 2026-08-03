import { Cause, Effect, Exit, Option } from "effect";

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
  const reject = (candidate: ProjectionBaseline, detail: string) =>
    Effect.uninterruptible(
      Effect.exit(input.baselines.markRejected(candidate.baselineId, detail)).pipe(
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.logWarning("projection baseline candidate cleanup failed", {
                candidateId: candidate.baselineId,
                sequence: candidate.sequence,
                cleanup: "reject",
                cause: exit.cause,
              }),
        ),
      ),
    );

  const verify = Effect.fn("verifyProjectionBaseline")(function* (
    candidate: ProjectionBaseline,
  ): Effect.fn.Return<boolean, ProjectionRepositoryError, never> {
    if (candidate.verificationStatus === "verified") return true;
    const verificationExit = yield* Effect.exit(
      Effect.gen(function* () {
        const previousOption = yield* input.baselines.latestVerified();
        const previous = Option.getOrUndefined(previousOption);
        if (previous && previous.sequence >= candidate.sequence) return false;
        return yield* input.verifyCandidate(candidate, previousOption);
      }),
    );
    if (Exit.isFailure(verificationExit)) {
      if (Cause.hasInterruptsOnly(verificationExit.cause)) {
        return yield* Effect.failCause(verificationExit.cause);
      }
      yield* reject(candidate, "terminal projection baseline verification failure");
      return yield* Effect.failCause(verificationExit.cause);
    }

    const matches = verificationExit.value;
    if (!matches) {
      yield* reject(
        candidate,
        `normalized replay hash mismatch: expected ${candidate.payloadHash}`,
      );
      return false;
    }
    const markVerifiedExit = yield* Effect.exit(
      input.baselines.markVerified(
        candidate.baselineId,
        candidate.sequence,
        new Date().toISOString(),
      ),
    );
    if (Exit.isFailure(markVerifiedExit)) {
      if (!Cause.hasInterruptsOnly(markVerifiedExit.cause)) {
        yield* reject(candidate, "terminal projection baseline finalization failure");
      }
      return yield* Effect.failCause(markVerifiedExit.cause);
    }
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
