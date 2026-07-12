import { ModelSelection, ProviderKind } from "@bigbud/contracts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TurnId } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const LearningJobState = Schema.Literals(["queued", "reviewing", "completed", "failed"]);
export type LearningJobState = typeof LearningJobState.Type;

export const LearningJob = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  threadId: ThreadId,
  turnId: TurnId,
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  memoryUserMessageCount: Schema.NullOr(Schema.Number),
  state: LearningJobState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LearningJob = typeof LearningJob.Type;

export const CreateLearningJobInput = LearningJob;
export type CreateLearningJobInput = typeof CreateLearningJobInput.Type;

export const SetLearningJobStateInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  state: LearningJobState,
  updatedAt: IsoDateTime,
});
export type SetLearningJobStateInput = typeof SetLearningJobStateInput.Type;

export const GetLatestMemoryUserMessageCountInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetLatestMemoryUserMessageCountInput = typeof GetLatestMemoryUserMessageCountInput.Type;

export interface LearningJobRepositoryShape {
  readonly createIfAbsent: (
    input: CreateLearningJobInput,
  ) => Effect.Effect<boolean, PersistenceSqlError | PersistenceDecodeError>;
  readonly listQueued: () => Effect.Effect<
    ReadonlyArray<LearningJob>,
    PersistenceSqlError | PersistenceDecodeError
  >;
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
