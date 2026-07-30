import { createHash } from "node:crypto";

import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type ProjectionRepositoryError,
  toPersistenceDecodeCauseError,
} from "../../persistence/Errors.ts";
import type { OrchestrationEventStoreShape } from "../../persistence/Services/OrchestrationEventStore.ts";
import type {
  ProjectionBaseline,
  ProjectionBaselineRepositoryShape,
} from "../../persistence/Services/ProjectionBaselines.ts";

interface VerificationRollback {
  readonly _tag: "ProjectionBaselineVerificationRollback";
  readonly matches: boolean;
  readonly detail: string;
}

function emptyProjectionPayload(candidatePayloadJson: string): string {
  const payload = JSON.parse(candidatePayloadJson) as {
    tables: Record<string, ReadonlyArray<Record<string, unknown>>>;
  };
  return JSON.stringify({
    tables: Object.fromEntries(Object.keys(payload.tables).map((table) => [table, []])),
  });
}

export function makeProjectionBaselineOperations(input: {
  readonly sql: SqlClient.SqlClient;
  readonly eventStore: OrchestrationEventStoreShape;
  readonly baselines: ProjectionBaselineRepositoryShape;
  readonly projectorNames: ReadonlyArray<string>;
  readonly replayEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}) {
  const verify = Effect.fn("verifyProjectionBaseline")(function* (candidate: ProjectionBaseline) {
    if (candidate.verificationStatus === "verified") return true;
    const previousOption = yield* input.baselines.latestVerified();
    const previous = Option.getOrUndefined(previousOption);
    if (previous && previous.sequence >= candidate.sequence) return false;

    const rollback = yield* input.sql
      .withTransaction(
        Effect.gen(function* () {
          const startSequence = previous?.sequence ?? 0;
          yield* input.baselines.restorePayload(
            previous?.payloadJson ?? emptyProjectionPayload(candidate.payloadJson),
            startSequence,
            input.projectorNames,
          );
          const replay = yield* input.eventStore.readReplay(startSequence, Number.MAX_SAFE_INTEGER);
          if (replay.availability === "gap") {
            return yield* toPersistenceDecodeCauseError("ProjectionBaseline.verify:retainedGap")(
              new Error(`retained history starts after ${startSequence}`),
            );
          }
          yield* Effect.forEach(
            replay.events.filter((event) => event.sequence <= candidate.sequence),
            (event, index) =>
              input
                .replayEvent(event)
                .pipe(Effect.andThen(index % 25 === 24 ? Effect.sleep("1 millis") : Effect.void)),
            { concurrency: 1, discard: true },
          );
          const payloadJson = yield* input.baselines.capturePayload();
          const hash = createHash("sha256").update(payloadJson).digest("hex");
          return yield* Effect.fail({
            _tag: "ProjectionBaselineVerificationRollback",
            matches: hash === candidate.payloadHash && payloadJson === candidate.payloadJson,
            detail:
              hash === candidate.payloadHash && payloadJson === candidate.payloadJson
                ? "verified"
                : `normalized replay hash mismatch: expected ${candidate.payloadHash}, received ${hash}`,
          } satisfies VerificationRollback);
        }),
      )
      .pipe(
        Effect.catch((error) =>
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "ProjectionBaselineVerificationRollback"
            ? Effect.succeed(error as VerificationRollback)
            : Effect.fail(error),
        ),
      );

    if (!rollback.matches) {
      yield* input.baselines.markRejected(candidate.baselineId, rollback.detail);
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
