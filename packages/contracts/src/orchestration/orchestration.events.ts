import { Schema } from "effect";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { OrchestrationAggregateKind } from "./orchestration.provider";
import {
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectDeletionFailedPayload,
  ProjectDeletionRequestedPayload,
  ProjectMetaUpdatedPayload,
} from "./orchestration.events.project";
import {
  ThreadActivityAppendedPayload,
  ThreadApprovalResponseRequestedPayload,
  ThreadArchivedPayload,
  ThreadCheckpointRevertRequestedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadDeletionFailedPayload,
  ThreadDeletionRequestedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMessageSentPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRevertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSessionSetPayload,
  ThreadSessionStopRequestedPayload,
  ThreadShellRunRequestedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnInterruptRequestedPayload,
  ThreadTurnStartRequestedPayload,
  ThreadUnarchivedPayload,
  ThreadUserInputResponseRequestedPayload,
} from "./orchestration.events.thread";

export {
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectDeletionFailedPayload,
  ProjectDeletionRequestedPayload,
  ProjectMetaUpdatedPayload,
} from "./orchestration.events.project";
export {
  ThreadActivityAppendedPayload,
  ThreadApprovalResponseRequestedPayload,
  ThreadArchivedPayload,
  ThreadCheckpointRevertRequestedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadDeletionFailedPayload,
  ThreadDeletionRequestedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMessageSentPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRevertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSessionSetPayload,
  ThreadSessionStopRequestedPayload,
  ThreadShellRunRequestedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnInterruptRequestedPayload,
  ThreadTurnStartRequestedPayload,
  ThreadUnarchivedPayload,
  ThreadUserInputResponseRequestedPayload,
} from "./orchestration.events.thread";

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deletion-requested",
  "project.deletion-failed",
  "project.deleted",
  "thread.created",
  "thread.deletion-requested",
  "thread.deletion-failed",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.shell-run-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deletion-requested"),
    payload: ProjectDeletionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deletion-failed"),
    payload: ProjectDeletionFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deletion-requested"),
    payload: ThreadDeletionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deletion-failed"),
    payload: ThreadDeletionFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.shell-run-requested"),
    payload: ThreadShellRunRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;
