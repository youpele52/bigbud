import { FiniteThreadRetentionPolicy } from "@bigbud/contracts/core/settings.threadRetention.ts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";
import type {
  ConsumeChallengeAndCreateRunResult,
  ConsumeManualChallengeResult,
  ConsumeRetentionChallengeInput,
  ConsumeRetentionChallengeResult,
  CreateRetentionRunInput,
  CreateScheduledRetentionRunResult,
  InsertRetentionItemsInput,
  InsertRetentionPageInput,
  InsertRetentionPageResult,
  IssuedRetentionChallenge,
  IssueRetentionChallengeInput,
  RecentThreadRetentionFailureSummary,
  RecheckAndClaimRetentionItemInput,
  RetentionChallenge,
  RetentionClaimResult,
  ThreadRetentionCandidate,
  ThreadRetentionCursor,
  ThreadRetentionPolicyAuthority,
  ThreadRetentionPreview,
  ThreadRetentionRetryState,
  ThreadRetentionRun,
  ThreadRetentionRunItem,
  ThreadRetentionRunStatus,
  TransitionRetentionItemInput,
  TransitionRetentionRunInput,
} from "./ThreadRetentionRepository.models.ts";

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
  readonly listQueuedManualRuns: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ThreadRetentionRun>, ProjectionRepositoryError>;
  readonly claimQueuedManualRun: (
    runId: string,
    claimedAt: string,
    purgeBacklogLimit: number,
  ) => Effect.Effect<Option.Option<ThreadRetentionRun>, ProjectionRepositoryError>;
  readonly yieldActiveRunToManual: (
    activeRunId: string,
    manualRunId: string,
    yieldedAt: string,
    purgeBacklogLimit: number,
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
    readonly isolateItemFailure?: boolean;
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
    readonly expectedStatuses: ReadonlyArray<"deletion_requested" | "prepared" | "purging">;
    readonly lastErrorCode: string;
    readonly nextAttemptAt: string;
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
  readonly consumeManualChallenge: (input: {
    readonly token: string;
    readonly consumedAt: string;
  }) => Effect.Effect<ConsumeManualChallengeResult, ProjectionRepositoryError>;
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
