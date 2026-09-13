import { ModelSelection, ProviderKind } from "@bigbud/contracts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TurnId } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { OrchestrationMessage } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const LearningJobState = Schema.Literals([
  "queued",
  "reviewing",
  "completed",
  "failed",
  "requires-reselection",
]);
export type LearningJobState = typeof LearningJobState.Type;

export const LearningJob = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  threadId: ThreadId,
  turnId: TurnId,
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  memoryUserMessageCount: Schema.NullOr(Schema.Number),
  attemptCount: Schema.Number.pipe(Schema.withDecodingDefault(() => 0)),
  nextAttemptAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  outcome: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  state: LearningJobState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LearningJob = typeof LearningJob.Type;

export const CreateLearningJobInput = LearningJob;
export type CreateLearningJobInput = Omit<
  LearningJob,
  "attemptCount" | "nextAttemptAt" | "outcome"
> &
  Partial<Pick<LearningJob, "attemptCount" | "nextAttemptAt" | "outcome">>;

export const SetLearningJobStateInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  state: LearningJobState,
  updatedAt: IsoDateTime,
  nextAttemptAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  outcome: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SetLearningJobStateInput = typeof SetLearningJobStateInput.Type;

export const GetLatestMemoryUserMessageCountInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetLatestMemoryUserMessageCountInput = typeof GetLatestMemoryUserMessageCountInput.Type;

export interface LearningJobRepositoryShape {
  readonly claim: (input: {
    jobId: string;
    now: string;
  }) => Effect.Effect<LearningJob | null, PersistenceSqlError | PersistenceDecodeError>;
  readonly recoverInterrupted: (input: {
    now: string;
  }) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
  readonly hasPending: (input: {
    threadId: ThreadId;
  }) => Effect.Effect<boolean, PersistenceSqlError | PersistenceDecodeError>;
  readonly countFinalizedUserMessages: (input: {
    threadId: ThreadId;
  }) => Effect.Effect<number, PersistenceSqlError | PersistenceDecodeError>;
  readonly getReviewMessages: (input: {
    threadId: ThreadId;
    turnId: TurnId;
  }) => Effect.Effect<
    ReadonlyArray<OrchestrationMessage>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly acquireLease: (input: {
    jobId: string;
    threadId: ThreadId;
  }) => Effect.Effect<boolean, PersistenceSqlError | PersistenceDecodeError>;
  readonly releaseLease: (
    jobId: string,
  ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
  readonly createIfAbsent: (
    input: CreateLearningJobInput,
  ) => Effect.Effect<boolean, PersistenceSqlError | PersistenceDecodeError>;
  readonly listQueued: (
    now?: string,
  ) => Effect.Effect<ReadonlyArray<LearningJob>, PersistenceSqlError | PersistenceDecodeError>;
  readonly getLatestMemoryUserMessageCount: (
    input: GetLatestMemoryUserMessageCountInput,
  ) => Effect.Effect<number | null, PersistenceSqlError | PersistenceDecodeError>;
  readonly setState: (
    input: SetLearningJobStateInput,
  ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
}

export class LearningJobRepository extends ServiceMap.Service<
  LearningJobRepository,
  LearningJobRepositoryShape
>()("t3/persistence/Services/LearningJobs/LearningJobRepository") {}
