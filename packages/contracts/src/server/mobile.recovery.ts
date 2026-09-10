import { Schema } from "effect";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";
import { OrchestrationEvent } from "../orchestration/orchestration.events";
import { OrchestrationReadModel, OrchestrationThread } from "../orchestration/orchestration.thread";

export const MOBILE_RECOVERY_WS_METHODS = {
  getBaseline: "mobile.recovery.getBaseline",
  subscribe: "mobile.recovery.subscribe",
} as const;

/** Protocol identities are echoed across retries and must stay bounded. */
export const MOBILE_RECOVERY_ID_MAX_LENGTH = 256;

/** A single recovery batch cannot contain more events than one replay page. */
export const MOBILE_RECOVERY_MAX_EVENTS_PER_BATCH = 500;

const MobileRecoveryIdentity = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MOBILE_RECOVERY_ID_MAX_LENGTH),
);

export const MobileRecoveryAttemptId = MobileRecoveryIdentity;
export type MobileRecoveryAttemptId = typeof MobileRecoveryAttemptId.Type;

export const MobileRecoveryBaselineInput = Schema.Struct({
  recoveryAttemptId: MobileRecoveryAttemptId,
  selectedThreadId: Schema.optional(ThreadId),
});
export type MobileRecoveryBaselineInput = typeof MobileRecoveryBaselineInput.Type;

export const MobileRecoverySelectedThread = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("present"),
    thread: OrchestrationThread,
  }),
  Schema.Struct({ status: Schema.Literal("missing") }),
  Schema.Struct({ status: Schema.Literal("deleted") }),
]);
export type MobileRecoverySelectedThread = typeof MobileRecoverySelectedThread.Type;

export const MobileRecoveryBaseline = Schema.Struct({
  version: Schema.Literal(1),
  recoveryAttemptId: MobileRecoveryAttemptId,
  serverEpoch: MobileRecoveryIdentity,
  snapshotSequence: NonNegativeInt,
  snapshot: OrchestrationReadModel,
  selectedThread: Schema.NullOr(MobileRecoverySelectedThread),
});
export type MobileRecoveryBaseline = typeof MobileRecoveryBaseline.Type;

export const MobileRecoverySubscriptionInput = Schema.Struct({
  recoveryAttemptId: MobileRecoveryAttemptId,
  /** Must equal the epoch returned by the matching baseline. */
  serverEpoch: MobileRecoveryIdentity,
  baselineSequence: NonNegativeInt,
});
export type MobileRecoverySubscriptionInput = typeof MobileRecoverySubscriptionInput.Type;

const MobileRecoveryFrameBase = {
  version: Schema.Literal(1),
  route: Schema.Literal("direct-unmanaged"),
  recoveryAttemptId: MobileRecoveryAttemptId,
  serverEpoch: MobileRecoveryIdentity,
} as const;

export const MobileRecoveryBatch = Schema.Struct({
  ...MobileRecoveryFrameBase,
  type: Schema.Literal("batch"),
  batchId: MobileRecoveryIdentity,
  events: Schema.Array(OrchestrationEvent).check(
    Schema.isMaxLength(MOBILE_RECOVERY_MAX_EVENTS_PER_BATCH),
  ),
});
export type MobileRecoveryBatch = typeof MobileRecoveryBatch.Type;

export const MobileRecoveryCaughtUp = Schema.Struct({
  ...MobileRecoveryFrameBase,
  type: Schema.Literal("caught-up"),
  throughSequence: NonNegativeInt,
});
export type MobileRecoveryCaughtUp = typeof MobileRecoveryCaughtUp.Type;

export const MobileRecoveryResyncReason = Schema.Literals([
  "gap",
  "overflow",
  "unavailable",
  "invalid-cursor",
  "timeout",
]);
export type MobileRecoveryResyncReason = typeof MobileRecoveryResyncReason.Type;

export const MobileRecoveryResyncRequired = Schema.Struct({
  ...MobileRecoveryFrameBase,
  type: Schema.Literal("resync-required"),
  reason: MobileRecoveryResyncReason,
});
export type MobileRecoveryResyncRequired = typeof MobileRecoveryResyncRequired.Type;

export const MobileRecoveryFrame = Schema.Union([
  MobileRecoveryBatch,
  MobileRecoveryCaughtUp,
  MobileRecoveryResyncRequired,
]);
export type MobileRecoveryFrame = typeof MobileRecoveryFrame.Type;

export class MobileRecoveryBaselineError extends Schema.TaggedErrorClass<MobileRecoveryBaselineError>()(
  "MobileRecoveryBaselineError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
