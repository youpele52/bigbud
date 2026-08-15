import { Effect } from "effect";

import { isPersistenceError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { PurgeJobRepositoryShape } from "../../persistence/Services/PurgeJobRepository.ts";

export function mapPurgeError(operation: string) {
  return (error: unknown) =>
    isPersistenceError(error) ? error : toPersistenceSqlError(operation)(error);
}

export function purgeRetryErrorMessage(error: unknown, mappedMessage: string): string {
  return error instanceof Error && error.message === "entity deletion marker is not yet available"
    ? error.message
    : mappedMessage;
}

export const purgeResourceOperation = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: mapPurgeError(operation) });

export const persistPurgeFailure = (input: {
  readonly attemptCount: number;
  readonly error: unknown;
  readonly failurePhase: Parameters<PurgeJobRepositoryShape["update"]>[0]["phase"];
  readonly jobId: string;
  readonly jobs: PurgeJobRepositoryShape;
}) => {
  const mappedError = mapPurgeError("EntityPurge.run")(input.error);
  return input.jobs
    .update({
      jobId: input.jobId,
      phase: input.failurePhase,
      status: "failed",
      lastError: purgeRetryErrorMessage(input.error, mappedError.message),
      updatedAt: nextPurgeRetryAt(input.attemptCount),
    })
    .pipe(Effect.ignore, Effect.andThen(Effect.fail(mappedError)));
};

export function nextPurgeRetryAt(attemptCount: number): string {
  const delay = Math.min(24 * 60 * 60 * 1_000, 15 * 60 * 1_000 * 2 ** attemptCount);
  return new Date(Date.now() + delay).toISOString();
}
