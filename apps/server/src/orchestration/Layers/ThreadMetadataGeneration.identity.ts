import { CommandId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  MetadataGenerationAttempt,
  MetadataGenerationJob,
} from "../../persistence/Services/ThreadMetadataGeneration.ts";
import {
  MetadataCapturedPath,
  type MetadataCapturedContext,
} from "./ThreadMetadataGeneration.context.ts";
import { MetadataCoordinatorError } from "./ThreadMetadataGeneration.coordinator.types.ts";
import { metadataExecutionFingerprint } from "./ThreadMetadataGeneration.policy.ts";

const AuxiliaryPayload = Schema.Struct({
  version: Schema.Literal(1),
  commandId: Schema.String,
  createdAt: Schema.String,
  path: MetadataCapturedPath,
});

export function metadataAttemptId(jobId: string, stage: string, ordinal: number): string {
  return `${jobId}:${stage}:${ordinal}`;
}

export function metadataCommandId(
  operation: MetadataCapturedContext["operation"],
  attemptId: string,
) {
  return CommandId.makeUnsafe(
    operation === "title"
      ? `server:thread-title-rename:${attemptId}`
      : `server:thread-elevator-summary-update:${attemptId}`,
  );
}

/** Validate original durable identity before dispatch AND before canonical persistence. */
export const readMetadataAuxiliaryIdentity = Effect.fn("readMetadataAuxiliaryIdentity")(function* (
  job: MetadataGenerationJob,
  attempt: MetadataGenerationAttempt,
  context: MetadataCapturedContext,
) {
  const invalid = () =>
    new MetadataCoordinatorError({ detail: "Retained attempt identity does not match its job." });
  const path = attempt.stage === "primary" ? context.primaryPath : context.threadPath;
  if (attempt.stage === "native" || !path) return yield* invalid();
  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(AuxiliaryPayload))(
    attempt.payloadJson,
    {
      onExcessProperty: "error",
    },
  ).pipe(Effect.mapError(invalid));
  if (
    attempt.jobId !== job.jobId ||
    attempt.threadId !== job.threadId ||
    attempt.threadId !== context.threadId ||
    job.operation !== context.operation ||
    attempt.attemptId !== metadataAttemptId(job.jobId, attempt.stage, attempt.ordinal) ||
    decoded.commandId !== metadataCommandId(context.operation, attempt.attemptId) ||
    decoded.createdAt !== attempt.createdAt ||
    metadataExecutionFingerprint(decoded.path) !== attempt.executionFingerprint ||
    attempt.executionFingerprint !== metadataExecutionFingerprint(path)
  )
    return yield* invalid();
  return decoded;
});

/** No new command IDs, timestamps, inputs, or generated values on persistence retries. */
export const makeMetadataResultCommand = Effect.fn("makeMetadataResultCommand")(function* (
  job: MetadataGenerationJob,
  attempt: MetadataGenerationAttempt,
  context: MetadataCapturedContext,
) {
  const payload = yield* readMetadataAuxiliaryIdentity(job, attempt, context);
  if (attempt.state !== "result-ready" || !attempt.result?.trim())
    return yield* new MetadataCoordinatorError({
      detail: "Metadata result is not ready for persistence.",
    });
  return {
    type: "thread.meta.update",
    commandId: CommandId.makeUnsafe(payload.commandId),
    threadId: job.threadId,
    ...(context.operation === "title"
      ? { title: attempt.result }
      : { elevatorSummary: attempt.result, elevatorSummaryMessageCount: context.source.frontier }),
  } satisfies OrchestrationCommand;
});

/** Server-only dispatch evidence, never a client command field or a model-supplied capability. */
export interface MetadataCommitIdentity {
  readonly jobId: string;
  readonly jobRevision: number;
  readonly attemptId: string;
  readonly attemptRevision: number;
  readonly owner: string;
  readonly payloadJson: string;
}

export function metadataCommitIdentity(
  job: MetadataGenerationJob,
  attempt: MetadataGenerationAttempt,
): MetadataCommitIdentity {
  return {
    jobId: job.jobId,
    jobRevision: job.revision,
    attemptId: attempt.attemptId,
    attemptRevision: attempt.revision,
    owner: attempt.owner,
    payloadJson: attempt.payloadJson,
  };
}
