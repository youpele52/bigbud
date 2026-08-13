import {
  FiniteThreadRetentionPolicy,
  type ThreadRetentionPolicy,
} from "@bigbud/contracts/core/settings.threadRetention.ts";
import { IsoDateTime, NonNegativeInt, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServiceMap from "effect/ServiceMap";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ThreadRetentionRunTrigger = Schema.Literals(["manual", "scheduled"]);
export type ThreadRetentionRunTrigger = typeof ThreadRetentionRunTrigger.Type;
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
export const ThreadRetentionItemStatus = Schema.Literals([
  "selected",
  "deletion_requested",
  "prepared",
  "purging",
  "completed",
  "skipped",
  "failed",
]);
export type ThreadRetentionItemStatus = typeof ThreadRetentionItemStatus.Type;
export const ThreadRetentionExclusionReason = Schema.Literals([
  "deleting",
  "pinned",
  "project_unavailable",
  "project_deleting",
  "remote_cleanup_unavailable",
  "running",
  "pending_work",
  "waiting_for_user",
  "active_task",
  "watched",
  "delegated",
  "scheduled",
  "activity_changed",
  "policy_changed",
]);
export type ThreadRetentionExclusionReason = typeof ThreadRetentionExclusionReason.Type;

export const ThreadRetentionCursor = Schema.Struct({
  lastActivityAt: IsoDateTime,
  threadId: ThreadId,
});
export type ThreadRetentionCursor = typeof ThreadRetentionCursor.Type;
export const ThreadRetentionCandidate = Schema.Struct({
  threadId: ThreadId,
  lastActivityAt: IsoDateTime,
});
export type ThreadRetentionCandidate = typeof ThreadRetentionCandidate.Type;
export const ThreadRetentionExclusionCount = Schema.Struct({
  reason: ThreadRetentionExclusionReason,
  count: NonNegativeInt,
});
export const ThreadRetentionPreview = Schema.Struct({
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
});
export type ThreadRetentionPreview = typeof ThreadRetentionPreview.Type;

export const ThreadRetentionRun = Schema.Struct({
  runId: Schema.String,
  trigger: ThreadRetentionRunTrigger,
  policy: FiniteThreadRetentionPolicy,
  cutoffAt: IsoDateTime,
  status: ThreadRetentionRunStatus,
  cursorLastActivityAt: Schema.NullOr(IsoDateTime),
  cursorThreadId: Schema.NullOr(ThreadId),
  eligibleCount: NonNegativeInt,
  selectedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  requestedCount: NonNegativeInt,
  completedCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  estimatedResourceCount: NonNegativeInt,
  requiredBaselineSequence: Schema.NullOr(NonNegativeInt),
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastErrorCode: Schema.NullOr(Schema.String),
  retryOrdinal: NonNegativeInt,
  failureWindowStartedAt: Schema.NullOr(IsoDateTime),
  failureCountInWindow: NonNegativeInt,
  lastFailureAt: Schema.NullOr(IsoDateTime),
  circuitOpenUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadRetentionRun = typeof ThreadRetentionRun.Type;
export const ThreadRetentionRunItem = Schema.Struct({
  runId: Schema.String,
  threadId: ThreadId,
  expectedLastActivityAt: IsoDateTime,
  deletionCommandId: Schema.String,
  purgeJobId: Schema.NullOr(Schema.String),
  status: ThreadRetentionItemStatus,
  exclusionReason: Schema.NullOr(ThreadRetentionExclusionReason),
  attemptCount: NonNegativeInt,
  lastErrorCode: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadRetentionRunItem = typeof ThreadRetentionRunItem.Type;

export type CreateRetentionRunInput = {
  readonly runId: string;
  readonly trigger: ThreadRetentionRunTrigger;
  readonly policy: typeof FiniteThreadRetentionPolicy.Type;
  readonly cutoffAt: string;
  readonly createdAt: string;
};
export type CreateScheduledRetentionRunResult = {
  readonly run: ThreadRetentionRun;
  readonly created: boolean;
};
export type InsertRetentionItemInput = ThreadRetentionCandidate & {
  readonly deletionCommandId: string;
};
export type InsertRetentionPageResult = {
  readonly applied: boolean;
  readonly insertedCount: number;
  readonly outstandingBacklogCount: number;
};
export type InsertRetentionPageInput = {
  readonly runId: string;
  readonly candidates: ReadonlyArray<InsertRetentionItemInput>;
  readonly createdAt: string;
  readonly expectedStatus: "selecting";
  readonly expectedCursor: ThreadRetentionCursor | null;
  readonly nextCursor: ThreadRetentionCursor;
};
export type InsertRetentionItemsInput = {
  readonly runId: string;
  readonly candidates: ReadonlyArray<InsertRetentionItemInput>;
  readonly createdAt: string;
  readonly cursor?: ThreadRetentionCursor;
};
export type ThreadRetentionRetryState = {
  readonly retryOrdinal: number;
  readonly failureWindowStartedAt: string | null;
  readonly failureCountInWindow: number;
  readonly lastFailureAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly circuitOpenUntil: string | null;
  readonly circuitOpen: boolean;
};
export type RecentThreadRetentionFailureSummary = {
  readonly failureCount: number;
  readonly latestFailureAt: string | null;
  readonly consecutiveFailureCount?: number;
};
export type TransitionRetentionRunInput = {
  readonly runId: string;
  readonly expectedStatuses: ReadonlyArray<ThreadRetentionRunStatus>;
  readonly nextStatus: ThreadRetentionRunStatus;
  readonly updatedAt: string;
  readonly cursor?: ThreadRetentionCursor | null;
  readonly nextAttemptAt?: string | null;
  readonly lastErrorCode?: string | null;
  readonly eligibleCount?: number;
  readonly estimatedResourceCount?: number;
  readonly requiredBaselineSequence?: number | null;
};
export type TransitionRetentionItemInput = {
  readonly runId: string;
  readonly threadId: typeof ThreadId.Type;
  readonly expectedStatuses: ReadonlyArray<ThreadRetentionItemStatus>;
  readonly nextStatus: ThreadRetentionItemStatus;
  readonly updatedAt: string;
  readonly purgeJobId?: string | null;
  readonly exclusionReason?: ThreadRetentionExclusionReason | null;
  readonly lastErrorCode?: string | null;
};
export type RecheckAndClaimRetentionItemInput = {
  readonly runId: string;
  readonly threadId: typeof ThreadId.Type;
  readonly expectedLastActivityAt: string;
  readonly cutoffAt: string;
  readonly claimedAt: string;
};
export type RetentionClaimResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly reason: ThreadRetentionExclusionReason | "not_selected" };

export type IssueRetentionChallengeInput = {
  readonly challengeId: string;
  readonly trigger: "manual" | "policy-change";
  readonly policy: typeof FiniteThreadRetentionPolicy.Type;
  readonly cutoffAt: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
};
export type IssuedRetentionChallenge = IssueRetentionChallengeInput & { readonly token: string };
export type RetentionChallenge = IssueRetentionChallengeInput & {
  readonly consumedAt: string | null;
};
export type ConsumeRetentionChallengeInput = {
  readonly token: string;
  readonly trigger: "manual" | "policy-change";
  readonly policy: typeof FiniteThreadRetentionPolicy.Type;
  readonly cutoffAt: string;
  readonly consumedAt: string;
};
export type ConsumeRetentionChallengeResult =
  | "consumed"
  | "invalid"
  | "expired"
  | "already_consumed";
export type ConsumeChallengeAndCreateRunResult =
  | { readonly consumed: true; readonly run: ThreadRetentionRun }
  | { readonly consumed: false; readonly result: ConsumeRetentionChallengeResult };
export type ThreadRetentionPolicyAuthority = {
  readonly policy: ThreadRetentionPolicy;
  readonly source: "explicit" | "rollout-automatic" | "rollout-protected" | "rollout-staged";
  readonly updatedAt: string;
};

export interface ThreadRetentionRepositoryShape {
  readonly preview: (
    cutoffAt: string,
  ) => Effect.Effect<ThreadRetentionPreview, ProjectionRepositoryError>;
  readonly listDeletionOwnedThreadIds: (
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, ProjectionRepositoryError>;
  readonly createOrGetActiveRun: (
    input: CreateRetentionRunInput,
  ) => Effect.Effect<ThreadRetentionRun, ProjectionRepositoryError>;
  readonly createQueuedRun: (
    input: CreateRetentionRunInput,
  ) => Effect.Effect<ThreadRetentionRun, ProjectionRepositoryError>;
  readonly createScheduledQueuedRun: (
    input: CreateRetentionRunInput & { readonly trigger: "scheduled" },
  ) => Effect.Effect<CreateScheduledRetentionRunResult, ProjectionRepositoryError>;
  readonly claimNextQueuedRun: (
    claimedAt: string,
  ) => Effect.Effect<Option.Option<ThreadRetentionRun>, ProjectionRepositoryError>;
  readonly selectNextPage: (input: {
    readonly cutoffAt: string;
    readonly cursor?: ThreadRetentionCursor;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ThreadRetentionCandidate>, ProjectionRepositoryError>;
  readonly insertSelectedItems: {
    (
      input: InsertRetentionPageInput,
    ): Effect.Effect<InsertRetentionPageResult, ProjectionRepositoryError>;
    (input: InsertRetentionItemsInput): Effect.Effect<number, ProjectionRepositoryError>;
  };
  readonly insertSelectedPage: (
    input: InsertRetentionPageInput,
  ) => Effect.Effect<InsertRetentionPageResult, ProjectionRepositoryError>;
  readonly recordRunFailure: (input: {
    readonly runId: string;
    readonly expectedStatuses: ReadonlyArray<ThreadRetentionRunStatus>;
    readonly failedAt: string;
    readonly lastErrorCode: string;
  }) => Effect.Effect<Option.Option<ThreadRetentionRetryState>, ProjectionRepositoryError>;
  readonly readRunRetryState: (
    runId: string,
    now: string,
  ) => Effect.Effect<Option.Option<ThreadRetentionRetryState>, ProjectionRepositoryError>;
  readonly clearRunRetryState: (input: {
    readonly runId: string;
    readonly expectedStatuses: ReadonlyArray<ThreadRetentionRunStatus>;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly getRecentFailureSummary: (input: {
    readonly since: string;
    readonly limit: number;
  }) => Effect.Effect<RecentThreadRetentionFailureSummary, ProjectionRepositoryError>;
  readonly countOutstandingItems: (
    runId: string,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly recordRequiredBaselineSequence: (input: {
    readonly runId: string;
    readonly sequence: number;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly recheckAndClaimItem: (
    input: RecheckAndClaimRetentionItemInput,
  ) => Effect.Effect<RetentionClaimResult, ProjectionRepositoryError>;
  readonly findItemByDeletionCommandId: (
    commandId: string,
  ) => Effect.Effect<Option.Option<ThreadRetentionRunItem>, ProjectionRepositoryError>;
  readonly listRunItems: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<ThreadRetentionRunItem>, ProjectionRepositoryError>;
  readonly listOutstandingItems: (
    runId: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ThreadRetentionRunItem>, ProjectionRepositoryError>;
  readonly transitionRun: (
    input: TransitionRetentionRunInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly transitionItem: (
    input: TransitionRetentionItemInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly recordItemRetry: (input: {
    readonly runId: string;
    readonly threadId: typeof ThreadId.Type;
    readonly expectedStatus: "deletion_requested";
    readonly lastErrorCode: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markPrepared: (input: {
    readonly runId: string;
    readonly threadId: typeof ThreadId.Type;
    readonly purgeJobId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly getRun: (
    runId: string,
  ) => Effect.Effect<Option.Option<ThreadRetentionRun>, ProjectionRepositoryError>;
  readonly listRecentRuns: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ThreadRetentionRun>, ProjectionRepositoryError>;
  readonly listRecoverableRuns: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ThreadRetentionRun>, ProjectionRepositoryError>;
  readonly cleanupAudit: (input: {
    readonly olderThan: string;
    readonly keepLatest: number;
  }) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly issueChallenge: (
    input: IssueRetentionChallengeInput,
  ) => Effect.Effect<IssuedRetentionChallenge, ProjectionRepositoryError>;
  readonly consumeChallenge: (
    input: ConsumeRetentionChallengeInput,
  ) => Effect.Effect<ConsumeRetentionChallengeResult, ProjectionRepositoryError>;
  readonly readChallenge: (
    token: string,
  ) => Effect.Effect<Option.Option<RetentionChallenge>, ProjectionRepositoryError>;
  readonly consumeChallengeAndCreateRun: (input: {
    readonly token: string;
    readonly trigger: "manual";
    readonly runId: string;
    readonly consumedAt: string;
  }) => Effect.Effect<ConsumeChallengeAndCreateRunResult, ProjectionRepositoryError>;
  readonly getPolicyAuthority: () => Effect.Effect<
    Option.Option<ThreadRetentionPolicyAuthority>,
    ProjectionRepositoryError
  >;
  readonly setPolicyAuthority: (
    input: ThreadRetentionPolicyAuthority,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly consumePolicyChallenge: (input: {
    readonly token: string;
    readonly policy: typeof FiniteThreadRetentionPolicy.Type;
    readonly consumedAt: string;
  }) => Effect.Effect<ConsumeRetentionChallengeResult, ProjectionRepositoryError>;
}

export class ThreadRetentionRepository extends ServiceMap.Service<
  ThreadRetentionRepository,
  ThreadRetentionRepositoryShape
>()("t3/persistence/Services/ThreadRetentionRepository") {}
