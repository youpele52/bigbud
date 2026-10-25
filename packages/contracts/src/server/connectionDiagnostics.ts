import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import {
  SERVER_STALL_MAX_SPANS,
  WS_CONNECTION_DIAGNOSTICS_CONSUMER_ID_MAX_LENGTH,
  WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT,
  WS_CONNECTION_DIAGNOSTICS_TEXT_MAX_LENGTH,
} from "../constants/connectionDiagnostics.constant";

const DiagnosticsText = Schema.String.check(
  Schema.isMaxLength(WS_CONNECTION_DIAGNOSTICS_TEXT_MAX_LENGTH),
);

/** What made the renderer send a connection report. */
export const WsConnectionDiagnosticsTrigger = Schema.Literals([
  "connect",
  "close",
  "error",
  "heartbeat-failure",
  "protocol-failure",
  "reconnect-success",
]);
export type WsConnectionDiagnosticsTrigger = typeof WsConnectionDiagnosticsTrigger.Type;

/**
 * One renderer-side connection transition. `reason` carries
 * `WS_CONNECTION_DIAGNOSTICS_PAGE_LOAD_REASON` ("page-load") on the first
 * connect after a navigation so reloads are never counted as disconnects.
 */
export const WsConnectionDiagnosticsReport = Schema.Struct({
  trigger: WsConnectionDiagnosticsTrigger,
  reason: Schema.optional(DiagnosticsText),
  closeCode: Schema.optional(Schema.Int),
  closeReason: Schema.optional(DiagnosticsText),
  attempt: NonNegativeInt,
  msSinceLastInboundEvent: Schema.optional(Schema.NullOr(NonNegativeInt)),
  consumerId: Schema.optional(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(WS_CONNECTION_DIAGNOSTICS_CONSUMER_ID_MAX_LENGTH),
    ),
  ),
  occurredAt: Schema.optional(IsoDateTime),
  detail: Schema.optional(DiagnosticsText),
});
export type WsConnectionDiagnosticsReport = typeof WsConnectionDiagnosticsReport.Type;

export const WsConnectionDiagnosticsReportResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type WsConnectionDiagnosticsReportResult = typeof WsConnectionDiagnosticsReportResult.Type;

export const WsConnectionDiagnosticsReportEntry = Schema.Struct({
  ...WsConnectionDiagnosticsReport.fields,
  sequence: NonNegativeInt,
  receivedAt: IsoDateTime,
});
export type WsConnectionDiagnosticsReportEntry = typeof WsConnectionDiagnosticsReportEntry.Type;

/**
 * A span that overlapped an event-loop stall. `spans` lists the likeliest
 * culprit first: longest overlap with the stall, long-lived spans last.
 */
export const ServerStallSpan = Schema.Struct({
  name: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
  /** Null while the span is still running when the stall is reported. */
  endedAt: Schema.NullOr(IsoDateTime),
});
export type ServerStallSpan = typeof ServerStallSpan.Type;

export const ServerStalledPayload = Schema.Struct({
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  spans: Schema.Array(ServerStallSpan).check(Schema.isMaxLength(SERVER_STALL_MAX_SPANS)),
  /** WebSocket RPC methods whose spans overlapped the stall. */
  inFlightRpcMethods: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMaxLength(SERVER_STALL_MAX_SPANS),
  ),
});
export type ServerStalledPayload = typeof ServerStalledPayload.Type;

/** Why an orchestration delivery session ended on the server. */
export const OrchestrationDeliverySessionEndReason = Schema.Literals([
  "client-close",
  "overflow",
  "handoff-ended",
  "server-shutdown",
  "superseded",
  "session-failed",
]);
export type OrchestrationDeliverySessionEndReason =
  typeof OrchestrationDeliverySessionEndReason.Type;

export const ServerConnectionStalledEvent = Schema.Struct({
  type: Schema.Literal("stalled"),
  sequence: NonNegativeInt,
  payload: ServerStalledPayload,
});
export type ServerConnectionStalledEvent = typeof ServerConnectionStalledEvent.Type;

export const ServerDeliverySessionEndedEvent = Schema.Struct({
  type: Schema.Literal("delivery-session-ended"),
  sequence: NonNegativeInt,
  at: IsoDateTime,
  consumerId: TrimmedNonEmptyString,
  reason: OrchestrationDeliverySessionEndReason,
  durationMs: NonNegativeInt,
});
export type ServerDeliverySessionEndedEvent = typeof ServerDeliverySessionEndedEvent.Type;

/**
 * A long event-loop gap the server attributed to system sleep rather than
 * publishing a stall. Only produced where the monotonic clock counts sleep
 * (Windows), where a long low-CPU blocking call can look the same, so it stays
 * visible here instead of being dropped.
 */
export const ServerSuspectedSystemSleepEvent = Schema.Struct({
  type: Schema.Literal("suspected-system-sleep"),
  sequence: NonNegativeInt,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationMs: NonNegativeInt,
});
export type ServerSuspectedSystemSleepEvent = typeof ServerSuspectedSystemSleepEvent.Type;

export const ServerConnectionDiagnosticsEvent = Schema.Union([
  ServerConnectionStalledEvent,
  ServerDeliverySessionEndedEvent,
  ServerSuspectedSystemSleepEvent,
]);
export type ServerConnectionDiagnosticsEvent = typeof ServerConnectionDiagnosticsEvent.Type;

/** Event-loop delay summary for one 10 s window. */
export const ServerEventLoopWindow = Schema.Struct({
  endedAt: IsoDateTime,
  windowMs: NonNegativeInt,
  p50Ms: Schema.Number,
  p99Ms: Schema.Number,
  maxMs: Schema.Number,
  stallCount: NonNegativeInt,
});
export type ServerEventLoopWindow = typeof ServerEventLoopWindow.Type;

export const ServerGetWsConnectionDiagnosticsInput = Schema.Struct({
  limit: Schema.optional(
    NonNegativeInt.check(Schema.isLessThanOrEqualTo(WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT)),
  ),
});
export type ServerGetWsConnectionDiagnosticsInput =
  typeof ServerGetWsConnectionDiagnosticsInput.Type;

/** Newest-first rings of renderer reports and server-side connection events. */
export const ServerWsConnectionDiagnosticsSnapshot = Schema.Struct({
  capturedAt: IsoDateTime,
  reports: Schema.Array(WsConnectionDiagnosticsReportEntry),
  serverEvents: Schema.Array(ServerConnectionDiagnosticsEvent),
  eventLoop: Schema.NullOr(ServerEventLoopWindow),
});
export type ServerWsConnectionDiagnosticsSnapshot =
  typeof ServerWsConnectionDiagnosticsSnapshot.Type;
