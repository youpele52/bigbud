import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type { ThreadMetadataGenerationRepositoryShape } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import type { MetadataCoordinatorFailure } from "./ThreadMetadataGeneration.coordinator.types.ts";

const PAGE_SIZE = 100;
const CONCURRENCY = 2;
const STEP_TIMEOUT_MS = 190_000;

/** A bounded SQL cursor and two background slots; never queues unbounded fibers or paid work. */
export const makeMetadataScheduler = Effect.fn("makeMetadataScheduler")(function* (input: {
  readonly repository: Pick<ThreadMetadataGenerationRepositoryShape, "listDue">;
  readonly now: () => string;
  readonly step: (jobId: string) => Effect.Effect<void, MetadataCoordinatorFailure>;
}) {
  const scope = yield* Effect.scope;
  const active = new Set<string>();
  let cursor = "";
  let scanning = false;
  let started = false;
  const report =
    (message: string) =>
    <E>(cause: Cause.Cause<E>) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message);

  const scan = Effect.fn("metadataScheduler.scan")(function* () {
    const jobs = yield* input.repository.listDue({
      at: input.now(),
      afterJobId: cursor,
      limit: PAGE_SIZE,
    });
    for (const job of jobs) {
      cursor = job.jobId;
      if (active.has(job.jobId)) continue;
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          active.add(job.jobId);
          yield* restore(Effect.suspend(() => input.step(job.jobId))).pipe(
            Effect.timeout(STEP_TIMEOUT_MS),
            Effect.catchCause(report("Metadata recovery step failed; durable evidence retained.")),
            Effect.ensuring(Effect.sync(() => active.delete(job.jobId))),
            Effect.forkIn(scope),
          );
        }),
      );
      if (active.size >= CONCURRENCY) return;
    }
    if (jobs.length < PAGE_SIZE) cursor = "";
  });

  const poll = () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        if (scanning || active.size >= CONCURRENCY) return false;
        scanning = true;
        return true;
      }),
      (acquired) => (acquired ? scan() : Effect.void),
      (acquired) =>
        Effect.sync(() => {
          if (acquired) scanning = false;
        }),
    );

  const start = Effect.fn("metadataScheduler.start")(function* () {
    if (started) return;
    started = true;
    yield* poll().pipe(
      Effect.catchCause(report("Metadata recovery scan failed; retrying bounded SQL scan.")),
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.forkIn(scope),
    );
  });
  return { poll, start };
});
