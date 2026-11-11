import { randomUUID } from "node:crypto";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { runMetadataGenerationAttempt } from "../../git/Layers/MetadataTextGeneration.ts";
import type {
  MetadataGenerationAttempt,
  MetadataGenerationJob,
} from "../../persistence/Services/ThreadMetadataGeneration.ts";
import type { MetadataCapturedContext } from "./ThreadMetadataGeneration.context.ts";
import {
  metadataAttemptId,
  metadataCommandId,
  readMetadataAuxiliaryIdentity,
} from "./ThreadMetadataGeneration.identity.ts";
import {
  MetadataCoordinatorError,
  type MetadataCoordinatorDependencies,
} from "./ThreadMetadataGeneration.coordinator.types.ts";
import { metadataExecutionFingerprint } from "./ThreadMetadataGeneration.policy.ts";
import { metadataTitleAdapter } from "./ThreadMetadataGeneration.title.ts";
import { metadataSummaryAdapter } from "./ThreadMetadataGeneration.summary.ts";

/** Resumes a prepared identity, but only the durable CAS winner can submit or settle paid work. */
export const executeMetadataAuxiliary = Effect.fn("executeMetadataAuxiliary")(function* (
  dependencies: MetadataCoordinatorDependencies,
  job: MetadataGenerationJob,
  context: MetadataCapturedContext,
  stage: "primary" | "thread-model",
  ordinal: number,
) {
  const { repository: r, host, textGeneration } = dependencies;
  const path = stage === "primary" ? context.primaryPath : context.threadPath;
  if (!path)
    return yield* new MetadataCoordinatorError({ detail: "Missing captured execution path." });
  const createdAt = host.now();
  const attemptId = metadataAttemptId(job.jobId, stage, ordinal);
  const payloadJson = JSON.stringify({
    version: 1,
    commandId: metadataCommandId(context.operation, attemptId),
    createdAt,
    path,
  });
  const prepared = yield* r.prepareAttempt({
    job,
    attempt: {
      attemptId,
      jobId: job.jobId,
      threadId: job.threadId,
      stage,
      ordinal,
      owner: randomUUID(),
      executionFingerprint: metadataExecutionFingerprint(path),
      payloadJson,
      providerSessionId: null,
      providerTurnId: null,
      sessionEpoch: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
  if (Option.isNone(prepared) || prepared.value.state !== "prepared") return;
  const attempt = prepared.value;
  const decoded = yield* readMetadataAuxiliaryIdentity(job, attempt, context);
  if (attempt.stage !== stage || attempt.ordinal !== ordinal)
    return yield* new MetadataCoordinatorError({
      detail: "Retained attempt stage is inconsistent.",
    });
  const settings = yield* host.providerSettings(context, decoded.path);
  if (!settings) {
    yield* r.settleAttempt({ attempt, state: "unavailable", at: host.now() });
    return;
  }
  const operation =
    context.operation === "title" ? "generateThreadTitle" : "generateThreadElevatorSummary";
  let claimWon = false;
  const beforeDispatch = Effect.fn("metadata.claimAuxiliaryDispatch")(function* () {
    yield* host
      .withDispatchAdmission(
        context,
        decoded.path,
        Effect.gen(function* () {
          if (!(yield* r.claimDispatch(attempt, host.now()))) {
            return yield* new TextGenerationError({
              operation,
              detail: "Dispatch claim refused.",
              metadataOutcome: "unavailable",
            });
          }
          claimWon = true;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "TextGenerationError"
            ? error
            : new TextGenerationError({
                operation,
                detail: "Dispatch admission could not be confirmed.",
                metadataOutcome: "uncertain",
              }),
        ),
      );
    if (!claimWon)
      return yield* new TextGenerationError({
        operation,
        detail: "Dispatch admission did not claim the attempt.",
        metadataOutcome: "unavailable",
      });
  });
  const outcome = yield* runMetadataGenerationAttempt<{ title?: string; summary?: string }>({
    operation,
    attempt: {
      selection: decoded.path.selection,
      executionTarget: decoded.path.executionTarget,
      providerSettings: settings,
      beforeDispatch,
    },
    ...(context.operation === "title" ? { titleSeed: context.titleSeed } : {}),
    generate: (metadataAttempt) =>
      context.operation === "title"
        ? metadataTitleAdapter
            .generate(textGeneration, context, metadataAttempt)
            .pipe(Effect.map((title) => ({ title })))
        : metadataSummaryAdapter
            .generate(textGeneration, context, metadataAttempt)
            .pipe(Effect.map((summary) => ({ summary }))),
  }).pipe(Effect.result);
  // A definitive preflight refusal can settle only this exact still-prepared revision.
  // A winning dispatch changes that revision/state, so a loser cannot settle its work.
  // Lost responses stay unknown; they never acquire this unavailable-only escape hatch.
  if (!claimWon) {
    if (outcome._tag === "Failure" && outcome.failure.metadataOutcome === "unavailable")
      yield* r.settleAttempt({ attempt, state: "unavailable", at: host.now() });
    return;
  }
  const state: MetadataGenerationAttempt["state"] =
    outcome._tag === "Success"
      ? "result-ready"
      : outcome.failure.metadataOutcome === "failed"
        ? "failed"
        : outcome.failure.metadataOutcome === "cancelled"
          ? "cancelled"
          : "uncertain";
  const result =
    outcome._tag === "Success" ? (outcome.success.title ?? outcome.success.summary) : undefined;
  // Keep the known outcome in this worker while retrying SQL only. A lost write response
  // is reconciled by reloading the immutable owner/payload, never by generating again.
  const persist = Effect.fn("metadata.persistAuxiliaryOutcome")(function* () {
    const current = (yield* r.listAttempts(job.jobId)).find(
      (a) => a.attemptId === attempt.attemptId,
    );
    if (
      !current ||
      current.owner !== attempt.owner ||
      current.payloadJson !== attempt.payloadJson ||
      !["dispatch-intent", "acknowledged", "uncertain"].includes(current.state)
    )
      return;
    const settled = yield* r.settleAttempt({
      attempt: current,
      state,
      at: host.now(),
      ...(result !== undefined ? { result } : {}),
    });
    if (!settled)
      return yield* new MetadataCoordinatorError({
        detail: "Attempt outcome CAS was not confirmed.",
      });
  });
  yield* persist().pipe(
    Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
    Effect.timeoutOrElse({
      duration: "8 seconds",
      orElse: () =>
        Effect.fail(
          new MetadataCoordinatorError({ detail: "Attempt outcome persistence timed out." }),
        ),
    }),
  );
});
