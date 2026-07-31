import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const ThreadDelegationState = Schema.Literals([
  "reserved",
  "project_resolved",
  "thread_accepted",
  "turn_accepted",
  "watch_armed",
  "completed",
  "compensating",
  "compensated",
  "failed",
]);
export type ThreadDelegationState = typeof ThreadDelegationState.Type;

export const ThreadDelegation = Schema.Struct({
  delegationId: TrimmedNonEmptyString,
  callerThreadId: ThreadId,
  sourceMessageId: MessageId,
  invocationId: TrimmedNonEmptyString,
  parentDelegationId: Schema.NullOr(TrimmedNonEmptyString),
  rootDelegationId: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  targetKind: TrimmedNonEmptyString,
  targetProjectId: Schema.NullOr(ProjectId),
  targetCanonicalWorkspace: Schema.NullOr(TrimmedNonEmptyString),
  childThreadId: ThreadId,
  childTurnId: TurnId,
  createdProjectId: Schema.NullOr(ProjectId),
  state: ThreadDelegationState,
  resultJson: Schema.NullOr(Schema.String),
  errorJson: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadDelegation = typeof ThreadDelegation.Type;

export const ReserveThreadDelegationInput = Schema.Struct({
  delegationId: ThreadDelegation.fields.delegationId,
  callerThreadId: ThreadDelegation.fields.callerThreadId,
  sourceMessageId: ThreadDelegation.fields.sourceMessageId,
  invocationId: ThreadDelegation.fields.invocationId,
  parentDelegationId: ThreadDelegation.fields.parentDelegationId,
  rootDelegationId: ThreadDelegation.fields.rootDelegationId,
  depth: ThreadDelegation.fields.depth,
  targetKind: ThreadDelegation.fields.targetKind,
  targetProjectId: ThreadDelegation.fields.targetProjectId,
  targetCanonicalWorkspace: ThreadDelegation.fields.targetCanonicalWorkspace,
  childThreadId: ThreadDelegation.fields.childThreadId,
  childTurnId: ThreadDelegation.fields.childTurnId,
  createdProjectId: ThreadDelegation.fields.createdProjectId,
  createdAt: ThreadDelegation.fields.createdAt,
  updatedAt: ThreadDelegation.fields.updatedAt,
});
export type ReserveThreadDelegationInput = typeof ReserveThreadDelegationInput.Type;

export const ThreadDelegationInvocation = Schema.Struct({
  callerThreadId: ThreadDelegation.fields.callerThreadId,
  sourceMessageId: ThreadDelegation.fields.sourceMessageId,
  invocationId: ThreadDelegation.fields.invocationId,
});
export type ThreadDelegationInvocation = typeof ThreadDelegationInvocation.Type;

export const ThreadDelegationByChild = Schema.Struct({
  childThreadId: ThreadDelegation.fields.childThreadId,
});
export type ThreadDelegationByChild = typeof ThreadDelegationByChild.Type;

export const UpdateThreadDelegationStateInput = Schema.Struct({
  delegationId: ThreadDelegation.fields.delegationId,
  state: ThreadDelegation.fields.state,
  updatedAt: ThreadDelegation.fields.updatedAt,
});
export type UpdateThreadDelegationStateInput = typeof UpdateThreadDelegationStateInput.Type;

export const StoreThreadDelegationResultInput = Schema.Struct({
  delegationId: ThreadDelegation.fields.delegationId,
  resultJson: ThreadDelegation.fields.resultJson,
  errorJson: ThreadDelegation.fields.errorJson,
  updatedAt: ThreadDelegation.fields.updatedAt,
});
export type StoreThreadDelegationResultInput = typeof StoreThreadDelegationResultInput.Type;

export interface ThreadDelegationRepositoryShape {
  readonly getByInvocation: (
    input: ThreadDelegationInvocation,
  ) => Effect.Effect<Option.Option<ThreadDelegation>, PersistenceSqlError | PersistenceDecodeError>;
  readonly reserve: (
    input: ReserveThreadDelegationInput,
  ) => Effect.Effect<ThreadDelegation, PersistenceSqlError | PersistenceDecodeError>;
  readonly updateState: (
    input: UpdateThreadDelegationStateInput,
  ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
  readonly storeResult: (
    input: StoreThreadDelegationResultInput,
  ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
  readonly findDirectByChild: (
    input: ThreadDelegationByChild,
  ) => Effect.Effect<Option.Option<ThreadDelegation>, PersistenceSqlError | PersistenceDecodeError>;
}

export class ThreadDelegationRepository extends ServiceMap.Service<
  ThreadDelegationRepository,
  ThreadDelegationRepositoryShape
>()("bigbud/persistence/Services/ThreadDelegations/ThreadDelegationRepository") {}
