import { Schema } from "effect";
import {
  EventId,
  IsoDateTime,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../core/baseSchemas";
import {
  TOOL_LIFECYCLE_ITEM_TYPES,
  RUNTIME_EVENT_RAW_SOURCES,
  RUNTIME_SESSION_STATES,
  RUNTIME_THREAD_STATES,
  RUNTIME_TURN_STATES,
  RUNTIME_PLAN_STEP_STATUSES,
  RUNTIME_ITEM_STATUSES,
  RUNTIME_CONTENT_STREAM_KINDS,
  CANONICAL_ITEM_TYPES,
  CANONICAL_REQUEST_TYPES,
} from "../constants/providerRuntime.constant";
import { ProviderKind } from "./orchestration.provider";

export { TOOL_LIFECYCLE_ITEM_TYPES };

export const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
export const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const RuntimeEventRawSource = Schema.Literals(RUNTIME_EVENT_RAW_SOURCES);
export type RuntimeEventRawSource = typeof RuntimeEventRawSource.Type;

export const RuntimeEventRaw = Schema.Struct({
  source: RuntimeEventRawSource,
  method: Schema.optional(TrimmedNonEmptyStringSchema),
  messageType: Schema.optional(TrimmedNonEmptyStringSchema),
  payload: Schema.Unknown,
});
export type RuntimeEventRaw = typeof RuntimeEventRaw.Type;

const ProviderRequestId = TrimmedNonEmptyStringSchema;
export type ProviderRequestId = typeof ProviderRequestId.Type;

export const ProviderRefs = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(ProviderRequestId),
});
export type ProviderRefs = typeof ProviderRefs.Type;

export const RuntimeSessionState = Schema.Literals(RUNTIME_SESSION_STATES);
export type RuntimeSessionState = typeof RuntimeSessionState.Type;

export const RuntimeThreadState = Schema.Literals(RUNTIME_THREAD_STATES);
export type RuntimeThreadState = typeof RuntimeThreadState.Type;

export const RuntimeTurnState = Schema.Literals(RUNTIME_TURN_STATES);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

export const RuntimePlanStepStatus = Schema.Literals(RUNTIME_PLAN_STEP_STATUSES);
export type RuntimePlanStepStatus = typeof RuntimePlanStepStatus.Type;

export const RuntimeItemStatus = Schema.Literals(RUNTIME_ITEM_STATUSES);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

export const RuntimeContentStreamKind = Schema.Literals(RUNTIME_CONTENT_STREAM_KINDS);
export type RuntimeContentStreamKind = typeof RuntimeContentStreamKind.Type;

export const RuntimeSessionExitKind = Schema.Literals(["graceful", "error"]);
export type RuntimeSessionExitKind = typeof RuntimeSessionExitKind.Type;

export const RuntimeErrorClass = Schema.Literals([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type RuntimeErrorClass = typeof RuntimeErrorClass.Type;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

export const CanonicalItemType = Schema.Literals(CANONICAL_ITEM_TYPES);
export type CanonicalItemType = typeof CanonicalItemType.Type;

export const CanonicalRequestType = Schema.Literals(CANONICAL_REQUEST_TYPES);
export type CanonicalRequestType = typeof CanonicalRequestType.Type;

export const ProviderRuntimeEventType = Schema.Literals([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.token-usage.updated",
  "thread.realtime.started",
  "thread.realtime.item-added",
  "thread.realtime.audio.delta",
  "thread.realtime.error",
  "thread.realtime.closed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.progress",
  "task.completed",
  "hook.started",
  "hook.progress",
  "hook.completed",
  "tool.progress",
  "tool.summary",
  "auth.status",
  "account.updated",
  "account.rate-limits.updated",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "model.rerouted",
  "config.warning",
  "deprecation.notice",
  "files.persisted",
  "runtime.warning",
  "runtime.error",
]);
export type ProviderRuntimeEventType = typeof ProviderRuntimeEventType.Type;

export const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(RuntimeItemId),
  requestId: Schema.optional(RuntimeRequestId),
  providerRefs: Schema.optional(ProviderRefs),
  raw: Schema.optional(RuntimeEventRaw),
});
export type ProviderRuntimeEventBase = typeof ProviderRuntimeEventBase.Type;

// Legacy helper alias
export const ProviderRuntimeToolKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "other",
]);
export type ProviderRuntimeToolKind = typeof ProviderRuntimeToolKind.Type;
