/**
 * ThreadRecoveryIntentRepository - durable recovery intent per accepted turn.
 *
 * One row per `(thread_id, message_id)` from `thread.turn-start-requested`. The stop
 * disposition decides whether recovery may ever act; the recovery status is the coordinator's
 * progress. Every coordinator write is a compare-and-set on `revision`.
 *
 * @module ThreadRecoveryIntentRepository
 */
import type { MessageId, ProviderKind, ThreadId, TurnId } from "@bigbud/contracts";
import type {
  ThreadRecoveryDisposition,
  ThreadRecoveryReason,
  ThreadRecoveryStatus,
} from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

/** Persisted in `recovery_detail_json`. Every field is optional so old rows stay readable. */
export interface ThreadRecoveryDetail {
  readonly reason?: ThreadRecoveryReason;
  readonly toolSummary?: string;
  readonly sleepEpochId?: number;
  /** Wall time the sleep ended, ISO. */
  readonly wokeAt?: string;
  /** Wall time a terminal failure of the turn was observed, ISO. */
  readonly failureObservedAt?: string;
  readonly failureDetail?: string;
  /** This intent is itself a continuation of that message. */
  readonly continuationOf?: MessageId;
  /** The latest continuation was authorized by the user; it does not count toward parking. */
  readonly userAuthorized?: boolean;
  /** Continuations the user authorized (Continue, Retry, Stop and continue). Never parks. */
  readonly userAttemptCount?: number;
}

export interface ThreadRecoveryIntent {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly provider: ProviderKind | null;
  readonly turnId: TurnId | null;
  readonly disposition: ThreadRecoveryDisposition;
  readonly recoveryStatus: ThreadRecoveryStatus;
  readonly detail: ThreadRecoveryDetail;
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly continuationMessageId: MessageId | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Fields a coordinator transition may change. */
export interface ThreadRecoveryIntentPatch {
  readonly disposition?: ThreadRecoveryDisposition;
  readonly recoveryStatus?: ThreadRecoveryStatus;
  readonly detail?: ThreadRecoveryDetail;
  readonly attemptCount?: number;
  readonly lastAttemptAt?: string | null;
  readonly continuationMessageId?: MessageId | null;
}

export interface ThreadRecoveryIntentKey {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/** Position after which the next page starts, in the listing's own order. */
export interface ThreadRecoveryIntentCursor extends ThreadRecoveryIntentKey {
  /** `updatedAt` for `listActive`, `createdAt` for `listUncertainAfterRestart`. */
  readonly at: string;
}

export interface ThreadRecoveryIntentRepositoryShape {
  /** Inserts an `active` intent; an existing row (for example a pre-seeded continuation) wins. */
  readonly recordAccepted: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly provider: ProviderKind | null;
    readonly createdAt: string;
    readonly detail?: ThreadRecoveryDetail;
    readonly attemptCount?: number;
  }) => Effect.Effect<void, PersistenceSqlError>;
  /** A new turn on the thread settles every other active intent except the one it continues. */
  readonly settleSupersededByTurnStart: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly at: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  /** User activity after a cut settles the thread's intents that are in recovery. */
  readonly settleRecoveringForThread: (input: {
    readonly threadId: ThreadId;
    readonly at: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  /** A user Stop: the thread's unfinished intents are never resumed. */
  readonly revokeForThread: (input: {
    readonly threadId: ThreadId;
    readonly at: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  /** App exit or `stopAll`: suspends, never revokes. Returns the number of rows changed. */
  readonly suspendActiveForExit: (input: {
    readonly at: string;
  }) => Effect.Effect<number, PersistenceSqlError>;
  readonly get: (
    key: ThreadRecoveryIntentKey,
  ) => Effect.Effect<Option.Option<ThreadRecoveryIntent>, PersistenceSqlError>;
  /**
   * Active intents, optionally limited to some recovery statuses, oldest update first. Bounded
   * and indexed; pass the last row as `after` to read the next page.
   */
  readonly listActive: (input?: {
    readonly statuses?: ReadonlyArray<ThreadRecoveryStatus>;
    readonly limit?: number;
    readonly after?: ThreadRecoveryIntentCursor;
  }) => Effect.Effect<ReadonlyArray<ThreadRecoveryIntent>, PersistenceSqlError>;
  /**
   * Prompts whose decision provider activity can still change: active, `awaiting-user`, reason
   * `no-activity-after-wake`. Newest first and bounded, so prompts nobody answers never crowd
   * out new ones.
   */
  readonly listAwaitingProviderActivity: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ThreadRecoveryIntent>, PersistenceSqlError>;
  /** The thread's most recently accepted intent that is not settled or revoked. */
  readonly latestOpenForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ThreadRecoveryIntent>, PersistenceSqlError>;
  /**
   * Intents a post-wake backend restart left uncertain: not settled or revoked, and whose
   * latest dispatch attempt may have reached the provider. Oldest first, one bounded page;
   * pass the last row as `after` (by `createdAt`) to read the next.
   */
  readonly listUncertainAfterRestart: (input?: {
    readonly limit?: number;
    readonly after?: ThreadRecoveryIntentCursor;
  }) => Effect.Effect<ReadonlyArray<ThreadRecoveryIntent>, PersistenceSqlError>;
  /**
   * Whether the remote agent may still be running the thread's shell command: its durable
   * owner (`shell:<threadId>`) is `may-have-been-sent` or `outcome-unknown`.
   */
  readonly hasUncertainRemoteShell: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  /** Compare-and-set on `revision`. Returns false when another writer won. */
  readonly transition: (input: {
    readonly key: ThreadRecoveryIntentKey;
    readonly expectedRevision: number;
    readonly patch: ThreadRecoveryIntentPatch;
    readonly at: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  /** Deletes settled and revoked intents (and their attempts) last updated before `before`. */
  readonly pruneResolved: (input: {
    readonly before: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
}

export class ThreadRecoveryIntentRepository extends ServiceMap.Service<
  ThreadRecoveryIntentRepository,
  ThreadRecoveryIntentRepositoryShape
>()("bigbud/persistence/Services/ThreadRecoveryIntentRepository") {}
