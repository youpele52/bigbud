import { Schema } from "effect";
import { ProviderRuntimeEventBase } from "./providerRuntime.primitives";
import {
  AccountRateLimitsUpdatedPayload,
  AccountUpdatedPayload,
  AuthStatusPayload,
  ConfigWarningPayload,
  DeprecationNoticePayload,
  FilesPersistedPayload,
  McpOauthCompletedPayload,
  McpStatusUpdatedPayload,
  ModelReroutedPayload,
  RuntimeErrorPayload,
  RuntimeWarningPayload,
} from "./providerRuntime.payloads";

export const ProviderRuntimeAuthStatusEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("auth.status"),
  payload: AuthStatusPayload,
});
export type ProviderRuntimeAuthStatusEvent = typeof ProviderRuntimeAuthStatusEvent.Type;

export const ProviderRuntimeAccountUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("account.updated"),
  payload: AccountUpdatedPayload,
});
export type ProviderRuntimeAccountUpdatedEvent = typeof ProviderRuntimeAccountUpdatedEvent.Type;

export const ProviderRuntimeAccountRateLimitsUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("account.rate-limits.updated"),
  payload: AccountRateLimitsUpdatedPayload,
});
export type ProviderRuntimeAccountRateLimitsUpdatedEvent =
  typeof ProviderRuntimeAccountRateLimitsUpdatedEvent.Type;

export const ProviderRuntimeMcpStatusUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("mcp.status.updated"),
  payload: McpStatusUpdatedPayload,
});
export type ProviderRuntimeMcpStatusUpdatedEvent = typeof ProviderRuntimeMcpStatusUpdatedEvent.Type;

export const ProviderRuntimeMcpOauthCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("mcp.oauth.completed"),
  payload: McpOauthCompletedPayload,
});
export type ProviderRuntimeMcpOauthCompletedEvent =
  typeof ProviderRuntimeMcpOauthCompletedEvent.Type;

export const ProviderRuntimeModelReroutedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("model.rerouted"),
  payload: ModelReroutedPayload,
});
export type ProviderRuntimeModelReroutedEvent = typeof ProviderRuntimeModelReroutedEvent.Type;

export const ProviderRuntimeConfigWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("config.warning"),
  payload: ConfigWarningPayload,
});
export type ProviderRuntimeConfigWarningEvent = typeof ProviderRuntimeConfigWarningEvent.Type;

export const ProviderRuntimeDeprecationNoticeEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("deprecation.notice"),
  payload: DeprecationNoticePayload,
});
export type ProviderRuntimeDeprecationNoticeEvent =
  typeof ProviderRuntimeDeprecationNoticeEvent.Type;

export const ProviderRuntimeFilesPersistedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("files.persisted"),
  payload: FilesPersistedPayload,
});
export type ProviderRuntimeFilesPersistedEvent = typeof ProviderRuntimeFilesPersistedEvent.Type;

export const ProviderRuntimeWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("runtime.warning"),
  payload: RuntimeWarningPayload,
});
export type ProviderRuntimeWarningEvent = typeof ProviderRuntimeWarningEvent.Type;

export const ProviderRuntimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: Schema.Literal("runtime.error"),
  payload: RuntimeErrorPayload,
});
export type ProviderRuntimeErrorEvent = typeof ProviderRuntimeErrorEvent.Type;
