import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { MetadataGenerationJob } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import {
  loadMetadataContext,
  tryBindMetadataThreadModel,
} from "./ThreadMetadataGeneration.modelBinding.ts";
import type { MetadataCoordinatorDependencies } from "./ThreadMetadataGeneration.coordinator.types.ts";
import { executeMetadataAuxiliary } from "./ThreadMetadataGeneration.execute.ts";
import {
  METADATA_GENERATION_LIMITS,
  metadataAttemptBlocksReplay,
  metadataExecutionFingerprint,
  metadataFingerprint,
  metadataJobIsTerminal,
  metadataWarningRequired,
  nextMetadataAction,
} from "./ThreadMetadataGeneration.policy.ts";

/** One bounded durable scheduling step. Restarting this coordinator never resets a budget. */
export function makeMetadataCoordinator(dependencies: MetadataCoordinatorDependencies) {
  const { repository: r, host } = dependencies;
  const transition = (
    job: MetadataGenerationJob,
    state: MetadataGenerationJob["state"],
    at: string,
  ) =>
    r.transitionJob({ jobId: job.jobId, expectedRevision: job.revision, state, nextAttemptAt: at });
  const step = Effect.fn("metadataCoordinator.step")(function* (jobId: string) {
    const found = yield* r.get(jobId);
    if (Option.isNone(found)) return;
    const job = found.value;
    const attempts = yield* r.listAttempts(jobId);
    const at = host.now();
    const now = Date.parse(at);
    // Historical native evidence is never executed, reconciled, erased, or treated as failure.
    if (attempts.some((a) => a.stage === "native")) {
      for (const attempt of attempts.filter((a) => a.stage === "native" && a.state === "prepared"))
        yield* r.settleAttempt({ attempt, state: "cancelled", at });
      if (attempts.some((a) => a.stage === "native" && metadataAttemptBlocksReplay(a.state))) {
        if (!metadataJobIsTerminal(job.state))
          yield* transition(job, "uncertain", new Date(now + 86_400_000).toISOString());
      } else yield* transition(job, "quarantined", at);
      return;
    }
    const context = yield* loadMetadataContext(r, job).pipe(
      Effect.catchTag("MetadataCoordinatorError", (error) =>
        Effect.gen(function* () {
          // Quarantine corrupt inputs without releasing any paid-work barrier.
          // SQL read failures propagate instead of being mistaken for corrupt evidence.
          for (const attempt of attempts.filter((a) => a.state === "prepared"))
            yield* r.settleAttempt({ attempt, state: "stale", at });
          yield* transition(job, "quarantined", at);
          return yield* error;
        }),
      ),
    );
    if (metadataWarningRequired(context.configuredPrimary, attempts, context.primaryPath !== null))
      yield* r.enqueueWarning({
        jobId,
        warningId: `metadata-warning:${metadataFingerprint(job.configEpoch)}`,
        at,
      });
    const retained = attempts.find((a) => a.state === "result-ready");
    if (retained) {
      yield* host.commitResult(job, retained, context);
      return;
    }
    if (attempts.some((a) => metadataAttemptBlocksReplay(a.state))) {
      return;
    }
    // Terminal settlement atomically persists any eligible final warning in the repository.
    if (metadataJobIsTerminal(job.state)) return;
    if (!(yield* host.isCurrent(context))) {
      for (const attempt of attempts.filter((a) => a.state === "prepared"))
        yield* r.settleAttempt({ attempt, state: "stale", at });
      yield* transition(job, "stale", at);
      return;
    }
    if (now < Date.parse(job.nextAttemptAt)) return;
    // Reconstruct backoff from durable outcomes even if the process died before rescheduling.
    const primaryFailures = attempts.filter((a) => a.stage === "primary" && a.state === "failed");
    if (
      attempts.every((a) => a.stage === "primary" && a.state === "failed") &&
      primaryFailures.length > 0
    ) {
      const last = primaryFailures.toSorted((a, b) => b.ordinal - a.ordinal)[0]!;
      const delay = METADATA_GENERATION_LIMITS.retryDelaysMs[last.ordinal - 1];
      const due = delay === undefined ? now : Date.parse(last.updatedAt) + delay;
      if (now < due && now < Date.parse(job.deadlineAt)) {
        yield* transition(
          job,
          "pending",
          new Date(Math.min(due, Date.parse(job.deadlineAt))).toISOString(),
        );
        return;
      }
    }
    if (
      !attempts.some(
        (a) => a.stage !== "primary" || !["failed", "unavailable"].includes(a.state),
      ) &&
      (yield* tryBindMetadataThreadModel(dependencies, job, context))
    )
      return;
    const policyInput = {
      state: job.state,
      attempts,
      now,
      deadline: Date.parse(job.deadlineAt),
      // Legacy active jobs may retain the old 60-second readiness window. Waiting
      // consumes no paid attempt and never extends the original overall deadline.
      modelWaitUntil: Date.parse(job.deadlineAt),
      primaryFingerprint:
        context.configuredPrimary && context.primaryPath
          ? metadataExecutionFingerprint(context.primaryPath)
          : null,
      threadModelFingerprint: context.threadPath
        ? metadataExecutionFingerprint(context.threadPath)
        : null,
    };
    const action = nextMetadataAction(policyInput);
    switch (action.type) {
      case "commit-result":
      case "reconcile":
        // Already handled above, before deadlines and eligibility checks.
        return;
      case "terminal":
        for (const attempt of attempts.filter((a) => a.state === "prepared"))
          yield* r.settleAttempt({ attempt, state: "cancelled", at });
        yield* transition(job, action.state, at);
        return;
      case "wait-model":
        yield* transition(
          job,
          "waiting-model",
          new Date(Math.min(now + 2_000, Date.parse(job.deadlineAt))).toISOString(),
        );
        return;
      case "attempt":
        yield* executeMetadataAuxiliary(dependencies, job, context, action.stage, action.ordinal);
        return;
    }
  });
  return { step };
}
