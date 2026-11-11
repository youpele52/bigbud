import { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  MetadataGenerationJob,
  ThreadMetadataGenerationRepositoryShape,
} from "../../persistence/Services/ThreadMetadataGeneration.ts";
import {
  decodeMetadataContext,
  MetadataCapturedPath,
  type MetadataCapturedContext,
} from "./ThreadMetadataGeneration.context.ts";
import {
  MetadataCoordinatorError,
  type MetadataCoordinatorDependencies,
} from "./ThreadMetadataGeneration.coordinator.types.ts";
import { metadataContextMatchesJob } from "./ThreadMetadataGeneration.jobs.ts";
import { metadataFingerprint } from "./ThreadMetadataGeneration.policy.ts";

/** Dispatch and canonical authorization must reconstruct the SAME immutable effective context. */
export const loadMetadataContext = Effect.fn("loadMetadataContext")(function* (
  repository: ThreadMetadataGenerationRepositoryShape,
  job: MetadataGenerationJob,
) {
  const invalid = () =>
    new MetadataCoordinatorError({
      detail: "Captured metadata context or model binding is invalid.",
    });
  const context = yield* decodeMetadataContext(job.contextJson).pipe(Effect.mapError(invalid));
  if (!metadataContextMatchesJob(context, job)) return yield* invalid();
  const found = yield* repository.readThreadModelBinding(job.jobId);
  if (Option.isNone(found)) return context;
  const binding = found.value;
  const path = yield* Schema.decodeEffect(Schema.fromJsonString(MetadataCapturedPath))(
    binding.pathJson,
    {
      onExcessProperty: "error",
    },
  ).pipe(Effect.mapError(invalid));
  const selection = yield* Schema.decodeEffect(Schema.fromJsonString(ModelSelection))(
    binding.verifiedModelJson,
    {
      onExcessProperty: "error",
    },
  ).pipe(Effect.mapError(invalid));
  const boundAt = Date.parse(binding.boundAt);
  if (
    binding.jobId !== job.jobId ||
    context.threadPath !== null ||
    (!context.configuredPrimary && context.primaryPath !== null) ||
    path.executionTarget !== context.workspace.executionTarget ||
    metadataFingerprint(path.selection) !== metadataFingerprint(selection) ||
    !Number.isFinite(boundAt) ||
    boundAt < Date.parse(job.createdAt) ||
    boundAt >= Date.parse(job.deadlineAt)
  )
    return yield* invalid();
  return {
    ...context,
    threadPath: path,
    primaryPath: context.primaryPath,
  };
});

/** Readiness is not a dispatch. Bind a proven model once; never replace any captured path. */
export const tryBindMetadataThreadModel = Effect.fn("tryBindMetadataThreadModel")(function* (
  dependencies: MetadataCoordinatorDependencies,
  job: MetadataGenerationJob,
  context: MetadataCapturedContext,
) {
  const { repository, host } = dependencies;
  if (context.threadPath || (!context.configuredPrimary && context.primaryPath)) return false;
  const now = Date.parse(host.now());
  if (now >= Date.parse(job.deadlineAt)) return false;
  const evidence = (yield* repository.readMetadataState(job.threadId)).successfulModelJson;
  if (!evidence) return false;
  const selection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection))(evidence);
  if (Option.isNone(selection)) return false;
  const path = yield* host
    .captureVerifiedThreadPath(context, selection.value)
    .pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(null) }));
  if (!path) return false;
  if (
    !Schema.is(MetadataCapturedPath)(path) ||
    path.executionTarget !== context.workspace.executionTarget ||
    metadataFingerprint(path.selection) !== metadataFingerprint(selection.value)
  )
    return yield* new MetadataCoordinatorError({
      detail: "Verified model capture changed the execution path.",
    });
  yield* repository.bindThreadModel({
    job,
    pathJson: JSON.stringify(path),
    verifiedModelJson: evidence,
    at: host.now(),
  });
  // Even a CAS loser must reload before preparing work with the old job revision.
  return true;
});
