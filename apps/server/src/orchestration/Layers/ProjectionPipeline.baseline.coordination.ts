import { Cause, Clock, Deferred, Effect, Exit, Option, Ref } from "effect";

import {
  isPersistenceError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import type { ProjectionBaselineRepositoryShape } from "../../persistence/Services/ProjectionBaselines.ts";

export const PROJECTION_BASELINE_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

export const makeProjectionBaselineCoordinator = Effect.fn("makeProjectionBaselineCoordinator")(
  function* (input: {
    readonly baselines: ProjectionBaselineRepositoryShape;
    readonly compact: Effect.Effect<void, ProjectionRepositoryError>;
  }) {
    type Flight = {
      readonly deferred: Deferred.Deferred<void, ProjectionRepositoryError>;
      readonly requestedSequence: number;
    };
    type FlightSelection = {
      readonly deferred: Deferred.Deferred<void, ProjectionRepositoryError>;
      readonly leader: boolean;
    };
    const flight = yield* Ref.make<Flight | null>(null);
    const failure = yield* Ref.make<{
      readonly failedAt: number;
      readonly error: ProjectionRepositoryError;
    } | null>(null);

    const markCovered = (
      deferred: Deferred.Deferred<void, ProjectionRepositoryError>,
      verifiedSequence: number,
    ) =>
      Ref.modify(flight, (current) => {
        if (current === null || current.deferred !== deferred) return [true, current] as const;
        return verifiedSequence >= current.requestedSequence
          ? ([true, null] as const)
          : ([false, current] as const);
      });

    const runFlight = (deferred: Deferred.Deferred<void, ProjectionRepositoryError>) =>
      Effect.uninterruptibleMask((restore) =>
        restore(
          Effect.gen(function* () {
            while (true) {
              const current = yield* Ref.get(flight);
              const requestedSequence =
                current?.deferred === deferred ? current.requestedSequence : 0;
              const verified = yield* input.baselines.latestVerified();
              if (
                Option.isSome(verified) &&
                (yield* markCovered(deferred, verified.value.sequence))
              ) {
                yield* Ref.set(failure, null);
                return;
              }

              const now = yield* Clock.currentTimeMillis;
              const previousFailure = yield* Ref.get(failure);
              if (
                previousFailure !== null &&
                now < previousFailure.failedAt + PROJECTION_BASELINE_FAILURE_COOLDOWN_MS
              ) {
                yield* Effect.logDebug("projection baseline verification cooldown active", {
                  requestedSequence,
                  cooldownMs: PROJECTION_BASELINE_FAILURE_COOLDOWN_MS,
                });
                return yield* previousFailure.error;
              }

              yield* input.compact;
              const afterCompact = yield* input.baselines.latestVerified();
              const updated = yield* Ref.get(flight);
              const currentRequested =
                updated?.deferred === deferred ? updated.requestedSequence : requestedSequence;
              if (
                Option.isSome(afterCompact) &&
                (yield* markCovered(deferred, afterCompact.value.sequence))
              ) {
                yield* Ref.set(failure, null);
                return;
              }
              if (
                currentRequested > requestedSequence &&
                Option.isSome(afterCompact) &&
                afterCompact.value.sequence >= requestedSequence
              ) {
                continue;
              }
              return yield* toPersistenceSqlError(
                "ProjectionPipeline.ensureBaseline:postcondition",
              )(
                new Error(`verified baseline did not reach requested sequence ${currentRequested}`),
              );
            }
          }),
        ).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              let completed = exit;
              if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
                const squashed = Cause.squash(exit.cause);
                const error: ProjectionRepositoryError = isPersistenceError(squashed)
                  ? (squashed as ProjectionRepositoryError)
                  : toPersistenceSqlError("ProjectionPipeline.ensureBaseline:verification")(
                      squashed,
                    );
                const previous = yield* Ref.get(failure);
                if (previous?.error !== error) {
                  yield* Ref.set(failure, {
                    failedAt: yield* Clock.currentTimeMillis,
                    error,
                  });
                }
                completed = Exit.fail(error);
              }
              yield* Deferred.done(deferred, completed);
              yield* Ref.update(flight, (current) =>
                current?.deferred === deferred ? null : current,
              );
              return yield* Deferred.await(deferred);
            }),
          ),
        ),
      );

    return (sequence: number) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<void, ProjectionRepositoryError>();
        const selection = yield* Ref.modify(
          flight,
          (current): readonly [FlightSelection, Flight | null] => {
            if (current !== null) {
              return [
                { deferred: current.deferred, leader: false },
                { ...current, requestedSequence: Math.max(current.requestedSequence, sequence) },
              ] as const;
            }
            return [
              { deferred, leader: true },
              { deferred, requestedSequence: sequence },
            ] as const;
          },
        );
        return yield* selection.leader
          ? runFlight(selection.deferred)
          : Deferred.await(selection.deferred);
      }).pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionPipeline.ensureBaseline:query")(error),
        ),
      );
  },
);
