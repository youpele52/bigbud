import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";

export const MetadataGenerationOperation = Schema.Literals(["title", "summary"]);
export type MetadataGenerationOperation = typeof MetadataGenerationOperation.Type;

export const MetadataGenerationStage = Schema.Literals(["primary", "thread-model", "native"]);
export type MetadataGenerationStage = typeof MetadataGenerationStage.Type;

export const MetadataGenerationJobState = Schema.Literals([
  "pending",
  "waiting-model",
  "waiting-native",
  "running",
  "uncertain",
  "result-ready",
  "completed",
  "stale",
  "cancelled",
  "exhausted",
  "unavailable",
  "quarantined",
]);
export type MetadataGenerationJobState = typeof MetadataGenerationJobState.Type;

export const MetadataGenerationAttemptState = Schema.Literals([
  "prepared",
  "dispatch-intent",
  "acknowledged",
  "uncertain",
  "result-ready",
  "completed",
  "failed",
  "stale",
  "cancelled",
  "unavailable",
]);
export type MetadataGenerationAttemptState = typeof MetadataGenerationAttemptState.Type;

/** A settings epoch is opaque. Neither warnings nor logs need credentials or raw provider errors. */
export const MetadataGenerationWarning = Schema.Struct({
  id: TrimmedNonEmptyString,
  configEpoch: TrimmedNonEmptyString,
  threadId: ThreadId,
  operation: MetadataGenerationOperation,
  createdAt: IsoDateTime,
  primaryFailures: NonNegativeInt,
  /** Absent on older servers means a configured-model settings warning. */
  kind: Schema.optionalKey(Schema.Literals(["settings", "final"])),
});
export type MetadataGenerationWarning = typeof MetadataGenerationWarning.Type;

/** Runtime origin is internal authority, not a prompt argument or evidence of a user turn. */
export const MetadataMaintenanceOrigin = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  attemptId: TrimmedNonEmptyString,
  operation: MetadataGenerationOperation,
  expectedRevision: NonNegativeInt,
  workspaceFingerprint: TrimmedNonEmptyString,
  grantId: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type MetadataMaintenanceOrigin = typeof MetadataMaintenanceOrigin.Type;
