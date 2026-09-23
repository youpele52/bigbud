import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import {
  FiniteThreadRetentionPolicy,
  ThreadRetentionAgeCriterion,
  ThreadRetentionSelectionMode,
} from "../core/settings.threadRetention";

export const ThreadRetentionConsentTrigger = Schema.Literals(["manual", "policy-change"]);
export type ThreadRetentionConsentTrigger = typeof ThreadRetentionConsentTrigger.Type;

export const ThreadRetentionConsentChallenge = Schema.Struct({
  token: TrimmedNonEmptyString,
  trigger: ThreadRetentionConsentTrigger,
  policy: FiniteThreadRetentionPolicy,
  selectionMode: ThreadRetentionSelectionMode,
  ageCriterion: ThreadRetentionAgeCriterion,
  cutoffAt: IsoDateTime,
  expiresAt: IsoDateTime,
  singleUse: Schema.Literal(true),
});
export type ThreadRetentionConsentChallenge = typeof ThreadRetentionConsentChallenge.Type;

export const ServerPreviewThreadRetentionInput = Schema.Struct({
  trigger: ThreadRetentionConsentTrigger,
  policy: FiniteThreadRetentionPolicy,
  ageCriterion: Schema.optional(ThreadRetentionAgeCriterion),
});
export type ServerPreviewThreadRetentionInput = typeof ServerPreviewThreadRetentionInput.Type;

export const ThreadRetentionExclusionCount = Schema.Struct({
  reason: TrimmedNonEmptyString,
  count: NonNegativeInt,
});

export const ThreadRetentionMaintenanceState = Schema.Literals([
  "available",
  "scheduled_active",
  "manual_active",
  "safety_deferred",
]);
export type ThreadRetentionMaintenanceState = typeof ThreadRetentionMaintenanceState.Type;

export const ServerThreadRetentionPreview = Schema.Struct({
  generatedAt: IsoDateTime,
  policy: FiniteThreadRetentionPolicy,
  selectionMode: ThreadRetentionSelectionMode,
  ageCriterion: ThreadRetentionAgeCriterion,
  cutoffAt: IsoDateTime,
  eligibleCount: NonNegativeInt,
  oldestEligibleAgeAt: Schema.NullOr(IsoDateTime),
  newestEligibleAgeAt: Schema.NullOr(IsoDateTime),
  exclusionCounts: Schema.Array(ThreadRetentionExclusionCount),
  estimatedAttachmentCount: NonNegativeInt,
  estimatedResourceCount: NonNegativeInt,
  estimatedKnownBytes: NonNegativeInt,
  attachmentEstimateComplete: Schema.Boolean,
  resourceEstimateComplete: Schema.Boolean,
  bytesEstimateComplete: Schema.Boolean,
  maintenanceState: ThreadRetentionMaintenanceState,
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
  selectionMode: Schema.optional(ThreadRetentionSelectionMode),
  ageCriterion: Schema.optional(ThreadRetentionAgeCriterion),
  cutoffAt: IsoDateTime,
  status: ThreadRetentionRunStatus,
  eligibleCount: NonNegativeInt,
  selectedCount: NonNegativeInt,
  requestedCount: NonNegativeInt,
  uncertainCount: Schema.optional(NonNegativeInt),
  completedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  removableResourceCount: Schema.optional(NonNegativeInt),
  completedResourceCount: Schema.optional(NonNegativeInt),
  retainedResourceCount: Schema.optional(NonNegativeInt),
  retainedSharedResourceCount: Schema.optional(NonNegativeInt),
  retainedExternalResourceCount: Schema.optional(NonNegativeInt),
  unverifiedResourceCount: Schema.optional(NonNegativeInt),
  pendingResourceCount: Schema.optional(NonNegativeInt),
  blockedResourceCount: Schema.optional(NonNegativeInt),
  canonicalPendingCount: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  deferredReason: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
});
export type ServerThreadRetentionRun = typeof ServerThreadRetentionRun.Type;

export const ServerThreadRetentionResult = Schema.Struct({
  trigger: Schema.Literals(["manual", "scheduled"]),
  policy: FiniteThreadRetentionPolicy,
  cutoffAt: IsoDateTime,
  eligibleCount: NonNegativeInt,
  deletedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  pendingCount: NonNegativeInt,
  completedAt: IsoDateTime,
});
export type ServerThreadRetentionResult = typeof ServerThreadRetentionResult.Type;

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
  policySelectionMode: Schema.optional(ThreadRetentionSelectionMode),
  policyAgeCriterion: Schema.optional(ThreadRetentionAgeCriterion),
});
export type ServerListThreadRetentionRunsResult = typeof ServerListThreadRetentionRunsResult.Type;

export const ServerSetThreadRetentionPolicyInput = Schema.Union([
  Schema.Struct({ policy: Schema.Literal("never") }),
  Schema.Struct({
    policy: FiniteThreadRetentionPolicy,
    ageCriterion: Schema.optional(ThreadRetentionAgeCriterion),
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
