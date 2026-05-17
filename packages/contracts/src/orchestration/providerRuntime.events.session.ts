import { Schema } from "effect";
import { ProviderRuntimeEventBase } from "./providerRuntime.primitives";
import {
  SessionConfiguredPayload,
  SessionExitedPayload,
  SessionStartedPayload,
  SessionStateChangedPayload,
  ThreadMetadataUpdatedPayload,
  ThreadRealtimeAudioDeltaPayload,
  ThreadRealtimeClosedPayload,
  ThreadRealtimeErrorPayload,
  ThreadRealtimeItemAddedPayload,
  ThreadRealtimeStartedPayload,
  ThreadStartedPayload,
  ThreadStateChangedPayload,
  ThreadTokenUsageUpdatedPayload,
} from "./providerRuntime.payloads";

export const ProviderRuntimeSessionStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("session.started"),
  payload: SessionStartedPayload,
});
export type ProviderRuntimeSessionStartedEvent = typeof ProviderRuntimeSessionStartedEvent.Type;

export const ProviderRuntimeSessionConfiguredEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("session.configured"),
  payload: SessionConfiguredPayload,
});
export type ProviderRuntimeSessionConfiguredEvent =
  typeof ProviderRuntimeSessionConfiguredEvent.Type;

export const ProviderRuntimeSessionStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("session.state.changed"),
  payload: SessionStateChangedPayload,
});
export type ProviderRuntimeSessionStateChangedEvent =
  typeof ProviderRuntimeSessionStateChangedEvent.Type;

export const ProviderRuntimeSessionExitedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("session.exited"),
  payload: SessionExitedPayload,
});
export type ProviderRuntimeSessionExitedEvent = typeof ProviderRuntimeSessionExitedEvent.Type;

export const ProviderRuntimeThreadStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("thread.started"),
  payload: ThreadStartedPayload,
});
export type ProviderRuntimeThreadStartedEvent = typeof ProviderRuntimeThreadStartedEvent.Type;

export const ProviderRuntimeThreadStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("thread.state.changed"),
  payload: ThreadStateChangedPayload,
});
export type ProviderRuntimeThreadStateChangedEvent =
  typeof ProviderRuntimeThreadStateChangedEvent.Type;

export const ProviderRuntimeThreadMetadataUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("thread.metadata.updated"),
  payload: ThreadMetadataUpdatedPayload,
});
export type ProviderRuntimeThreadMetadataUpdatedEvent =
  typeof ProviderRuntimeThreadMetadataUpdatedEvent.Type;

export const ProviderRuntimeThreadTokenUsageUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("thread.token-usage.updated"),
  payload: ThreadTokenUsageUpdatedPayload,
});
export type ProviderRuntimeThreadTokenUsageUpdatedEvent =
  typeof ProviderRuntimeThreadTokenUsageUpdatedEvent.Type;

export const ProviderRuntimeThreadRealtimeStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("thread.realtime.started"),
  payload: ThreadRealtimeStartedPayload,
});
export type ProviderRuntimeThreadRealtimeStartedEvent =
  typeof ProviderRuntimeThreadRealtimeStartedEvent.Type;

export const ProviderRuntimeThreadRealtimeItemAddedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("thread.realtime.item-added"),
  payload: ThreadRealtimeItemAddedPayload,
});
export type ProviderRuntimeThreadRealtimeItemAddedEvent =
  typeof ProviderRuntimeThreadRealtimeItemAddedEvent.Type;

export const ProviderRuntimeThreadRealtimeAudioDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("thread.realtime.audio.delta"),
  payload: ThreadRealtimeAudioDeltaPayload,
});
export type ProviderRuntimeThreadRealtimeAudioDeltaEvent =
  typeof ProviderRuntimeThreadRealtimeAudioDeltaEvent.Type;

export const ProviderRuntimeThreadRealtimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("thread.realtime.error"),
  payload: ThreadRealtimeErrorPayload,
});
export type ProviderRuntimeThreadRealtimeErrorEvent =
  typeof ProviderRuntimeThreadRealtimeErrorEvent.Type;

export const ProviderRuntimeThreadRealtimeClosedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("thread.realtime.closed"),
  payload: ThreadRealtimeClosedPayload,
});
export type ProviderRuntimeThreadRealtimeClosedEvent =
  typeof ProviderRuntimeThreadRealtimeClosedEvent.Type;
