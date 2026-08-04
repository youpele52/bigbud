import { Effect } from "effect";

import type {
  PurgeJob,
  PurgeJobRepositoryShape,
} from "../../persistence/Services/PurgeJobRepository.ts";

export function makePurgeJobTransitions(jobs: PurgeJobRepositoryShape) {
  const updateJob = Effect.fn("EntityPurge.updateJob")(function* (
    job: PurgeJob,
    phase: PurgeJob["phase"],
  ) {
    const updated = yield* jobs.update({
      jobId: job.jobId,
      phase,
      status: "running",
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    if (!updated) return yield* Effect.fail(new Error("purge job state changed remotely"));
  });

  const transitionJob = Effect.fn("EntityPurge.transitionJob")(function* (
    job: PurgeJob,
    expectedPhase: PurgeJob["phase"],
    nextPhase: PurgeJob["phase"],
  ) {
    const transitioned = yield* jobs.transition({
      jobId: job.jobId,
      expectedPhase,
      nextPhase,
      updatedAt: new Date().toISOString(),
    });
    if (!transitioned) return yield* Effect.fail(new Error("purge job state changed remotely"));
  });

  return { transitionJob, updateJob };
}
