import {
  AutomationId,
  AutomationRun,
  AutomationRunId,
  AutomationSchedule,
  CommandId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const CreateAutomationScheduleInput = Schema.Struct({
  automationId: AutomationId,
  projectId: ProjectId,
  targetThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  scheduleKind: Schema.Literals(["custom", "once"]),
  scheduleLabel: TrimmedNonEmptyString,
  cronExpression: TrimmedNonEmptyString,
  timezone: TrimmedNonEmptyString,
  runAt: Schema.NullOr(IsoDateTime),
  nextRunAt: Schema.NullOr(IsoDateTime),
});
export type CreateAutomationScheduleInput = typeof CreateAutomationScheduleInput.Type;

export const GetAutomationScheduleInput = Schema.Struct({
  automationId: AutomationId,
});
export type GetAutomationScheduleInput = typeof GetAutomationScheduleInput.Type;

export const ListAutomationSchedulesByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListAutomationSchedulesByProjectInput =
  typeof ListAutomationSchedulesByProjectInput.Type;

export const ClaimDueAutomationSchedulesInput = Schema.Struct({
  now: IsoDateTime,
  leaseUntil: IsoDateTime,
  limit: Schema.Number,
});
export type ClaimDueAutomationSchedulesInput = typeof ClaimDueAutomationSchedulesInput.Type;

export const UpdateAutomationScheduleInput = Schema.Struct({
  automationId: AutomationId,
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  scheduleKind: Schema.optional(Schema.Literals(["custom", "once"])),
  scheduleLabel: Schema.optional(TrimmedNonEmptyString),
  cronExpression: Schema.optional(TrimmedNonEmptyString),
  timezone: Schema.optional(TrimmedNonEmptyString),
  runAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  nextRunAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  updatedAt: IsoDateTime,
});
export type UpdateAutomationScheduleInput = typeof UpdateAutomationScheduleInput.Type;

export const UpdateAutomationScheduleNextRunInput = Schema.Struct({
  automationId: AutomationId,
  nextRunAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type UpdateAutomationScheduleNextRunInput = typeof UpdateAutomationScheduleNextRunInput.Type;

export const PauseAutomationScheduleInput = Schema.Struct({
  automationId: AutomationId,
  pausedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PauseAutomationScheduleInput = typeof PauseAutomationScheduleInput.Type;

export const ResumeAutomationScheduleInput = Schema.Struct({
  automationId: AutomationId,
  nextRunAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ResumeAutomationScheduleInput = typeof ResumeAutomationScheduleInput.Type;

export const CompleteAutomationScheduleInput = Schema.Struct({
  automationId: AutomationId,
  completedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CompleteAutomationScheduleInput = typeof CompleteAutomationScheduleInput.Type;

export const DeleteAutomationScheduleInput = Schema.Struct({
  automationId: AutomationId,
  deletedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DeleteAutomationScheduleInput = typeof DeleteAutomationScheduleInput.Type;

export const RecordAutomationRunStartedInput = Schema.Struct({
  runId: AutomationRunId,
  automationId: AutomationId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  startedAt: IsoDateTime,
});
export type RecordAutomationRunStartedInput = typeof RecordAutomationRunStartedInput.Type;

export const RecordAutomationRunFinishedInput = Schema.Struct({
  runId: AutomationRunId,
  finishedAt: IsoDateTime,
});
export type RecordAutomationRunFinishedInput = typeof RecordAutomationRunFinishedInput.Type;

export const RecordAutomationRunFailedInput = Schema.Struct({
  runId: AutomationRunId,
  finishedAt: IsoDateTime,
  errorMessage: TrimmedNonEmptyString,
});
export type RecordAutomationRunFailedInput = typeof RecordAutomationRunFailedInput.Type;

export const ListAutomationRunsInput = Schema.Struct({
  automationId: AutomationId,
  limit: Schema.Number,
});
export type ListAutomationRunsInput = typeof ListAutomationRunsInput.Type;

export type AutomationScheduleRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface AutomationScheduleRepositoryShape {
  readonly create: (
    input: CreateAutomationScheduleInput,
  ) => Effect.Effect<AutomationSchedule, AutomationScheduleRepositoryError>;
  readonly getById: (
    input: GetAutomationScheduleInput,
  ) => Effect.Effect<Option.Option<AutomationSchedule>, AutomationScheduleRepositoryError>;
  readonly listByProject: (
    input: ListAutomationSchedulesByProjectInput,
  ) => Effect.Effect<ReadonlyArray<AutomationSchedule>, AutomationScheduleRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<AutomationSchedule>,
    AutomationScheduleRepositoryError
  >;
  readonly claimDue: (
    input: ClaimDueAutomationSchedulesInput,
  ) => Effect.Effect<ReadonlyArray<AutomationSchedule>, AutomationScheduleRepositoryError>;
  readonly update: (
    input: UpdateAutomationScheduleInput,
  ) => Effect.Effect<AutomationSchedule, AutomationScheduleRepositoryError>;
  readonly updateNextRun: (
    input: UpdateAutomationScheduleNextRunInput,
  ) => Effect.Effect<void, AutomationScheduleRepositoryError>;
  readonly pause: (
    input: PauseAutomationScheduleInput,
  ) => Effect.Effect<void, AutomationScheduleRepositoryError>;
  readonly resume: (
    input: ResumeAutomationScheduleInput,
  ) => Effect.Effect<void, AutomationScheduleRepositoryError>;
  readonly complete: (
    input: CompleteAutomationScheduleInput,
  ) => Effect.Effect<void, AutomationScheduleRepositoryError>;
  readonly delete: (
    input: DeleteAutomationScheduleInput,
  ) => Effect.Effect<void, AutomationScheduleRepositoryError>;
  readonly recordRunStarted: (
    input: RecordAutomationRunStartedInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly recordRunFinished: (
    input: RecordAutomationRunFinishedInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly recordRunFailed: (
    input: RecordAutomationRunFailedInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listRuns: (
    input: ListAutomationRunsInput,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationScheduleRepositoryError>;
}

export class AutomationScheduleRepository extends ServiceMap.Service<
  AutomationScheduleRepository,
  AutomationScheduleRepositoryShape
>()("t3/persistence/Services/AutomationScheduleRepository/AutomationScheduleRepository") {}
