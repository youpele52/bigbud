import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type {
  MetadataGenerationAttemptState,
  MetadataGenerationJobState,
  MetadataGenerationOperation,
  MetadataGenerationStage,
  MetadataGenerationWarning,
} from "@bigbud/contracts/orchestration/orchestration.metadataGeneration.ts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface MetadataGenerationJob {
  readonly jobId: string;
  readonly threadId: ThreadId;
  readonly operation: MetadataGenerationOperation;
  readonly generationKey: string;
  readonly configEpoch: string;
  readonly state: MetadataGenerationJobState;
  /** Immutable, versioned captured input. Decoded by the operation adapter, never silently replaced. */
  readonly contextJson: string;
  readonly expectedRevision: number;
  readonly sourceFrontier: number;
  readonly workspaceFingerprint: string;
  readonly createdAt: string;
  readonly deadlineAt: string;
  readonly modelWaitUntil: string;
  readonly nativeWaitUntil: string;
  readonly nextAttemptAt: string;
  readonly revision: number;
}

export interface MetadataGenerationAttempt {
  readonly attemptId: string;
  readonly jobId: string;
  readonly threadId: ThreadId;
  readonly stage: MetadataGenerationStage;
  readonly ordinal: number;
  readonly owner: string;
  readonly executionFingerprint: string;
  readonly state: MetadataGenerationAttemptState;
  /** Includes the immutable command identity, timestamp, selection, and grant where applicable. */
  readonly payloadJson: string;
  readonly result: string | null;
  readonly providerSessionId: string | null;
  readonly providerTurnId: string | null;
  readonly sessionEpoch: number | null;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface MetadataThreadModelBinding {
  readonly jobId: string;
  readonly pathJson: string;
  readonly verifiedModelJson: string;
  readonly boundAt: string;
}

export interface ThreadMetadataState {
  readonly titleRevision: number;
  readonly summaryRevision: number;
  readonly summaryAttemptedFrontier: number;
  readonly successfulModelJson: string | null;
}

type StoreEffect<A> = Effect.Effect<A, PersistenceSqlError>;

export interface ThreadMetadataGenerationRepositoryShape {
  /** Coalesces both same-generation and concurrent open jobs. Never resets existing evidence. */
  readonly createOrGet: (
    job: Omit<MetadataGenerationJob, "revision" | "state">,
  ) => StoreEffect<MetadataGenerationJob>;
  readonly get: (jobId: string) => StoreEffect<Option.Option<MetadataGenerationJob>>;
  readonly findOpen: (
    threadId: ThreadId,
    operation: MetadataGenerationOperation,
  ) => StoreEffect<Option.Option<MetadataGenerationJob>>;
  /** Retire only a never-dispatched capture, atomically fencing prepared dispatchers. */
  readonly retireUndispatched: (job: MetadataGenerationJob, at: string) => StoreEffect<boolean>;
  readonly listDue: (input: {
    readonly at: string;
    readonly afterJobId?: string;
    readonly limit: number;
  }) => StoreEffect<ReadonlyArray<MetadataGenerationJob>>;
  readonly transitionJob: (input: {
    readonly jobId: string;
    readonly expectedRevision: number;
    readonly state: MetadataGenerationJobState;
    readonly nextAttemptAt: string;
  }) => StoreEffect<boolean>;
  /** Prepared owner/identity is persisted once; duplicate reservation returns the original row. */
  readonly prepareAttempt: (input: {
    readonly job: MetadataGenerationJob;
    readonly attempt: Omit<
      MetadataGenerationAttempt,
      "state" | "result" | "dispatchedAt" | "revision"
    >;
  }) => StoreEffect<Option.Option<MetadataGenerationAttempt>>;
  /** CAS-only, before the bounded readiness deadline; retained bindings are never replaced. */
  readonly bindThreadModel: (input: {
    readonly job: MetadataGenerationJob;
    readonly pathJson: string;
    readonly verifiedModelJson: string;
    readonly at: string;
  }) => StoreEffect<boolean>;
  readonly readThreadModelBinding: (
    jobId: string,
  ) => StoreEffect<Option.Option<MetadataThreadModelBinding>>;
  readonly listAttempts: (jobId: string) => StoreEffect<ReadonlyArray<MetadataGenerationAttempt>>;
  /** A CAS won by exactly one dispatcher, committed BEFORE any external work. */
  readonly claimDispatch: (attempt: MetadataGenerationAttempt, at: string) => StoreEffect<boolean>;
  readonly settleAttempt: (input: {
    readonly attempt: MetadataGenerationAttempt;
    readonly state: Exclude<MetadataGenerationAttemptState, "prepared" | "dispatch-intent">;
    readonly at: string;
    readonly result?: string;
    readonly providerSessionId?: string;
    readonly providerTurnId?: string;
    readonly sessionEpoch?: number;
  }) => StoreEffect<boolean>;
  readonly readMetadataState: (threadId: ThreadId) => StoreEffect<ThreadMetadataState>;
  /** Called inside the canonical event transaction, including explicit user edits. */
  readonly advanceMetadataRevision: (
    threadId: ThreadId,
    operation: MetadataGenerationOperation,
  ) => StoreEffect<void>;
  readonly recordSuccessfulModel: (threadId: ThreadId, modelJson: string) => StoreEffect<void>;
  /** SQL verifies a configured path is unavailable or has two definitive failures. */
  readonly enqueueWarning: (input: {
    readonly jobId: string;
    readonly warningId: string;
    readonly at: string;
  }) => StoreEffect<boolean>;
  /** Definitive verified-thread failure only; deduplicated per thread and operation. */
  readonly enqueueFinalWarning: (input: {
    readonly jobId: string;
    readonly at: string;
  }) => StoreEffect<boolean>;
  readonly listPendingWarnings: (
    limit: number,
  ) => StoreEffect<ReadonlyArray<MetadataGenerationWarning>>;
  /** Atomically leases a bounded deliverable page, skipping other renderers' live claims. */
  readonly claimPendingWarnings: (input: {
    readonly clientId: string;
    readonly at: string;
    readonly until: string;
  }) => StoreEffect<ReadonlyArray<MetadataGenerationWarning>>;
  readonly claimWarning: (input: {
    readonly warningId: string;
    readonly clientId: string;
    readonly at: string;
    readonly until: string;
  }) => StoreEffect<boolean>;
  readonly acknowledgeWarning: (input: {
    readonly warningId: string;
    readonly clientId: string;
    readonly at: string;
  }) => StoreEffect<boolean>;
}

export class ThreadMetadataGenerationRepository extends ServiceMap.Service<
  ThreadMetadataGenerationRepository,
  ThreadMetadataGenerationRepositoryShape
>()("bigbud/persistence/ThreadMetadataGenerationRepository") {}
