import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { FiniteThreadRetentionPolicy } from "../core/settings.threadRetention";

export const ThreadRetentionConsentTrigger = Schema.Literals(["manual", "policy-change"]);
export type ThreadRetentionConsentTrigger = typeof ThreadRetentionConsentTrigger.Type;

export const ThreadRetentionConsentChallenge = Schema.Struct({
  token: TrimmedNonEmptyString,
  trigger: ThreadRetentionConsentTrigger,
  policy: FiniteThreadRetentionPolicy,
  cutoffAt: IsoDateTime,
  expiresAt: IsoDateTime,
  singleUse: Schema.Literal(true),
});
export type ThreadRetentionConsentChallenge = typeof ThreadRetentionConsentChallenge.Type;

export const ServerPreviewThreadRetentionInput = Schema.Struct({
  trigger: ThreadRetentionConsentTrigger,
  policy: FiniteThreadRetentionPolicy,
});
export type ServerPreviewThreadRetentionInput = typeof ServerPreviewThreadRetentionInput.Type;

export const ThreadRetentionExclusionCount = Schema.Struct({
  reason: TrimmedNonEmptyString,
  count: NonNegativeInt,
});

export const ServerThreadRetentionPreview = Schema.Struct({
  generatedAt: IsoDateTime,
  policy: FiniteThreadRetentionPolicy,
  cutoffAt: IsoDateTime,
  eligibleCount: NonNegativeInt,
  oldestEligibleActivityAt: Schema.NullOr(IsoDateTime),
  newestEligibleActivityAt: Schema.NullOr(IsoDateTime),
  exclusionCounts: Schema.Array(ThreadRetentionExclusionCount),
  estimatedAttachmentCount: NonNegativeInt,
  estimatedResourceCount: NonNegativeInt,
  estimatedKnownBytes: NonNegativeInt,
  attachmentEstimateComplete: Schema.Boolean,
  resourceEstimateComplete: Schema.Boolean,
  bytesEstimateComplete: Schema.Boolean,
  maintenanceState: Schema.Literals(["available", "active", "deferred"]),
  warnings: Schema.Array(Schema.String),
  challenge: ThreadRetentionConsentChallenge,
});
export type ServerThreadRetentionPreview = typeof ServerThreadRetentionPreview.Type;

export const ThreadRetentionRunStatus = Schema.Literals([
  "queued",
  "selecting",
  "preparing",
  "purging",
  "deferred",
  "completed",
  "completed_with_failures",
  "failed",
  "cancelled",
]);
export type ThreadRetentionRunStatus = typeof ThreadRetentionRunStatus.Type;

export const ServerThreadRetentionRun = Schema.Struct({
  runId: TrimmedNonEmptyString,
  trigger: Schema.Literals(["manual", "scheduled"]),
  policy: FiniteThreadRetentionPolicy,
  cutoffAt: IsoDateTime,
  status: ThreadRetentionRunStatus,
  eligibleCount: NonNegativeInt,
  selectedCount: NonNegativeInt,
  requestedCount: NonNegativeInt,
  completedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  deferredReason: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
});
export type ServerThreadRetentionRun = typeof ServerThreadRetentionRun.Type;

export const ServerStartThreadRetentionInput = Schema.Struct({
  challengeToken: TrimmedNonEmptyString,
});
export type ServerStartThreadRetentionInput = typeof ServerStartThreadRetentionInput.Type;

export const ServerGetThreadRetentionRunInput = Schema.Struct({
  runId: TrimmedNonEmptyString,
});
export type ServerGetThreadRetentionRunInput = typeof ServerGetThreadRetentionRunInput.Type;

export const ServerListThreadRetentionRunsInput = Schema.Struct({
  limit: Schema.optional(PositiveInt),
});
export type ServerListThreadRetentionRunsInput = typeof ServerListThreadRetentionRunsInput.Type;

export const ServerListThreadRetentionRunsResult = Schema.Struct({
  runs: Schema.Array(ServerThreadRetentionRun),
  availability: Schema.Literals(["available", "disabled"]),
});
export type ServerListThreadRetentionRunsResult = typeof ServerListThreadRetentionRunsResult.Type;

export const ServerSetThreadRetentionPolicyInput = Schema.Union([
  Schema.Struct({ policy: Schema.Literal("never") }),
  Schema.Struct({
    policy: FiniteThreadRetentionPolicy,
    challengeToken: TrimmedNonEmptyString,
  }),
]);
export type ServerSetThreadRetentionPolicyInput = typeof ServerSetThreadRetentionPolicyInput.Type;

export class ServerThreadRetentionError extends Schema.TaggedErrorClass<ServerThreadRetentionError>()(
  "ServerThreadRetentionError",
  {
    code: Schema.Literals([
      "validation",
      "unauthorized",
      "disabled",
      "busy",
      "challenge_expired",
      "challenge_invalid",
      "challenge_consumed",
      "not_found",
      "failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
