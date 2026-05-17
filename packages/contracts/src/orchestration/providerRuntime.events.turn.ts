import { Schema } from "effect";
import { ProviderRuntimeEventBase } from "./providerRuntime.primitives";
import {
  ContentDeltaPayload,
  HookCompletedPayload,
  HookProgressPayload,
  HookStartedPayload,
  ItemLifecyclePayload,
  RequestOpenedPayload,
  RequestResolvedPayload,
  TaskCompletedPayload,
  TaskProgressPayload,
  TaskStartedPayload,
  ToolProgressPayload,
  ToolSummaryPayload,
  TurnAbortedPayload,
  TurnCompletedPayload,
  TurnDiffUpdatedPayload,
  TurnPlanUpdatedPayload,
  TurnProposedCompletedPayload,
  TurnProposedDeltaPayload,
  TurnStartedPayload,
  UserInputRequestedPayload,
  UserInputResolvedPayload,
} from "./providerRuntime.payloads";

export const ProviderRuntimeTurnStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("turn.started"),
  payload: TurnStartedPayload,
});
export type ProviderRuntimeTurnStartedEvent = typeof ProviderRuntimeTurnStartedEvent.Type;

export const ProviderRuntimeTurnCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("turn.completed"),
  payload: TurnCompletedPayload,
});
export type ProviderRuntimeTurnCompletedEvent = typeof ProviderRuntimeTurnCompletedEvent.Type;

export const ProviderRuntimeTurnAbortedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("turn.aborted"),
  payload: TurnAbortedPayload,
});
export type ProviderRuntimeTurnAbortedEvent = typeof ProviderRuntimeTurnAbortedEvent.Type;

export const ProviderRuntimeTurnPlanUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("turn.plan.updated"),
  payload: TurnPlanUpdatedPayload,
});
export type ProviderRuntimeTurnPlanUpdatedEvent = typeof ProviderRuntimeTurnPlanUpdatedEvent.Type;

export const ProviderRuntimeTurnProposedDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("turn.proposed.delta"),
  payload: TurnProposedDeltaPayload,
});
export type ProviderRuntimeTurnProposedDeltaEvent =
  typeof ProviderRuntimeTurnProposedDeltaEvent.Type;

export const ProviderRuntimeTurnProposedCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("turn.proposed.completed"),
  payload: TurnProposedCompletedPayload,
});
export type ProviderRuntimeTurnProposedCompletedEvent =
  typeof ProviderRuntimeTurnProposedCompletedEvent.Type;

export const ProviderRuntimeTurnDiffUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("turn.diff.updated"),
  payload: TurnDiffUpdatedPayload,
});
export type ProviderRuntimeTurnDiffUpdatedEvent = typeof ProviderRuntimeTurnDiffUpdatedEvent.Type;

export const ProviderRuntimeItemStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("item.started"),
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemStartedEvent = typeof ProviderRuntimeItemStartedEvent.Type;

export const ProviderRuntimeItemUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("item.updated"),
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemUpdatedEvent = typeof ProviderRuntimeItemUpdatedEvent.Type;

export const ProviderRuntimeItemCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("item.completed"),
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemCompletedEvent = typeof ProviderRuntimeItemCompletedEvent.Type;

export const ProviderRuntimeContentDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("content.delta"),
  payload: ContentDeltaPayload,
});
export type ProviderRuntimeContentDeltaEvent = typeof ProviderRuntimeContentDeltaEvent.Type;

export const ProviderRuntimeRequestOpenedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("request.opened"),
  payload: RequestOpenedPayload,
});
export type ProviderRuntimeRequestOpenedEvent = typeof ProviderRuntimeRequestOpenedEvent.Type;

export const ProviderRuntimeRequestResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("request.resolved"),
  payload: RequestResolvedPayload,
});
export type ProviderRuntimeRequestResolvedEvent = typeof ProviderRuntimeRequestResolvedEvent.Type;

export const ProviderRuntimeUserInputRequestedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("user-input.requested"),
  payload: UserInputRequestedPayload,
});
export type ProviderRuntimeUserInputRequestedEvent =
  typeof ProviderRuntimeUserInputRequestedEvent.Type;

export const ProviderRuntimeUserInputResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("user-input.resolved"),
  payload: UserInputResolvedPayload,
});
export type ProviderRuntimeUserInputResolvedEvent =
  typeof ProviderRuntimeUserInputResolvedEvent.Type;

export const ProviderRuntimeTaskStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("task.started"),
  payload: TaskStartedPayload,
});
export type ProviderRuntimeTaskStartedEvent = typeof ProviderRuntimeTaskStartedEvent.Type;

export const ProviderRuntimeTaskProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("task.progress"),
  payload: TaskProgressPayload,
});
export type ProviderRuntimeTaskProgressEvent = typeof ProviderRuntimeTaskProgressEvent.Type;

export const ProviderRuntimeTaskCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("task.completed"),
  payload: TaskCompletedPayload,
});
export type ProviderRuntimeTaskCompletedEvent = typeof ProviderRuntimeTaskCompletedEvent.Type;

export const ProviderRuntimeHookStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("hook.started"),
  payload: HookStartedPayload,
});
export type ProviderRuntimeHookStartedEvent = typeof ProviderRuntimeHookStartedEvent.Type;

export const ProviderRuntimeHookProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("hook.progress"),
  payload: HookProgressPayload,
});
export type ProviderRuntimeHookProgressEvent = typeof ProviderRuntimeHookProgressEvent.Type;

export const ProviderRuntimeHookCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("hook.completed"),
  payload: HookCompletedPayload,
});
export type ProviderRuntimeHookCompletedEvent = typeof ProviderRuntimeHookCompletedEvent.Type;

export const ProviderRuntimeToolProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("tool.progress"),
  payload: ToolProgressPayload,
});
export type ProviderRuntimeToolProgressEvent = typeof ProviderRuntimeToolProgressEvent.Type;

export const ProviderRuntimeToolSummaryEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("tool.summary"),
  payload: ToolSummaryPayload,
});
export type ProviderRuntimeToolSummaryEvent = typeof ProviderRuntimeToolSummaryEvent.Type;
