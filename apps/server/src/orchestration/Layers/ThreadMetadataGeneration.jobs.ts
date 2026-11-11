import type { MetadataGenerationJob } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import type { MetadataCapturedContext } from "./ThreadMetadataGeneration.context.ts";
import {
  METADATA_GENERATION_LIMITS,
  metadataFingerprint,
} from "./ThreadMetadataGeneration.policy.ts";

export function makeMetadataJobInput(input: {
  readonly context: MetadataCapturedContext;
  readonly generationKey: string;
  readonly at: string;
}): Omit<MetadataGenerationJob, "state" | "revision"> {
  const { context, generationKey, at } = input;
  const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
  const workspaceFingerprint = metadataFingerprint(context.workspace);
  return {
    jobId: `metadata:${metadataFingerprint({ context, generationKey })}`,
    threadId: context.threadId,
    operation: context.operation,
    generationKey,
    configEpoch: context.configEpoch,
    contextJson: JSON.stringify(context),
    expectedRevision: context.expectedRevision,
    sourceFrontier: context.source.frontier,
    workspaceFingerprint,
    createdAt: at,
    deadlineAt: after(METADATA_GENERATION_LIMITS.jobDeadlineMs),
    modelWaitUntil: after(METADATA_GENERATION_LIMITS.verifiedModelWaitMs),
    nativeWaitUntil: after(METADATA_GENERATION_LIMITS.nativeWaitMs),
    nextAttemptAt: at,
  };
}

export function metadataContextMatchesJob(
  context: MetadataCapturedContext,
  job: MetadataGenerationJob,
): boolean {
  return (
    context.threadId === job.threadId &&
    context.operation === job.operation &&
    context.expectedRevision === job.expectedRevision &&
    context.source.frontier === job.sourceFrontier &&
    context.configEpoch === job.configEpoch &&
    metadataFingerprint(context.workspace) === job.workspaceFingerprint &&
    [context.primaryPath, context.threadPath].every(
      (path) => path === null || path.executionTarget === context.workspace.executionTarget,
    )
  );
}
