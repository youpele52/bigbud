import type {
  ServerConnectionDiagnosticsEvent,
  ServerEventLoopWindow,
  WsConnectionDiagnosticsReportEntry,
} from "@bigbud/contracts/server/connectionDiagnostics.ts";
import {
  WS_CONNECTION_DIAGNOSTICS_READ_DEFAULT_LIMIT,
  WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT,
} from "@bigbud/contracts/constants/connectionDiagnostics.constant.ts";
import { Effect, Layer } from "effect";

import { TRACE_RETAIN_ATTRIBUTE } from "../../observability/TracePolicy.ts";
import { BoundedRing } from "../ConnectionDiagnostics.ring.ts";
import {
  ConnectionDiagnostics,
  type ConnectionDiagnosticsShape,
} from "../Services/ConnectionDiagnostics.ts";

export const CONNECTION_DIAGNOSTICS_REPORT_CAPACITY = WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT;
export const CONNECTION_DIAGNOSTICS_SERVER_EVENT_CAPACITY =
  WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT;

/** Stable span names, so every record of one kind can be found in the trace file. */
export const CONNECTION_REPORT_SPAN = "ws.connection.diagnostics";
export const SERVER_STALLED_SPAN = "server.stalled";
export const DELIVERY_SESSION_ENDED_SPAN = "orchestration.delivery.session.ended";
export const SUSPECTED_SYSTEM_SLEEP_SPAN = "server.suspected_system_sleep";

const traced = (name: string, attributes: Record<string, unknown>, root = false) =>
  Effect.withSpan(name, { root, attributes: { ...attributes, [TRACE_RETAIN_ATTRIBUTE]: true } });

export const makeConnectionDiagnostics = (
  options: {
    readonly reportCapacity?: number;
    readonly serverEventCapacity?: number;
    readonly now?: () => Date;
  } = {},
): ConnectionDiagnosticsShape => {
  const now = options.now ?? (() => new Date());
  const reports = new BoundedRing<WsConnectionDiagnosticsReportEntry>(
    options.reportCapacity ?? CONNECTION_DIAGNOSTICS_REPORT_CAPACITY,
  );
  const serverEvents = new BoundedRing<ServerConnectionDiagnosticsEvent>(
    options.serverEventCapacity ?? CONNECTION_DIAGNOSTICS_SERVER_EVENT_CAPACITY,
  );
  let reportSequence = 0;
  let serverEventSequence = 0;
  let eventLoop: ServerEventLoopWindow | null = null;
  let serverShuttingDown = false;

  return {
    recordReport: (report) =>
      Effect.suspend(() => {
        reportSequence += 1;
        const entry = { ...report, sequence: reportSequence, receivedAt: now().toISOString() };
        reports.push(entry);
        const attributes = {
          "connection.trigger": entry.trigger,
          "connection.reason": entry.reason,
          "connection.close_code": entry.closeCode,
          "connection.close_reason": entry.closeReason,
          "connection.attempt": entry.attempt,
          "connection.ms_since_last_inbound": entry.msSinceLastInboundEvent ?? undefined,
          "connection.consumer_id": entry.consumerId,
          "connection.occurred_at": entry.occurredAt,
          "connection.detail": entry.detail,
        };
        return Effect.logInfo("ws connection diagnostics report").pipe(
          Effect.annotateLogs(attributes),
          traced(CONNECTION_REPORT_SPAN, attributes),
          Effect.as(entry),
        );
      }),
    recordStall: (payload) =>
      Effect.suspend(() => {
        serverEventSequence += 1;
        serverEvents.push({ type: "stalled", sequence: serverEventSequence, payload });
        const attributes = {
          "stall.duration_ms": payload.durationMs,
          "stall.started_at": payload.startedAt,
          "stall.ended_at": payload.endedAt,
          "stall.spans": payload.spans.map((span) => span.name).join(", "),
          "stall.rpc_methods": payload.inFlightRpcMethods.join(", "),
        };
        return Effect.logWarning("server event loop stalled").pipe(
          Effect.annotateLogs(attributes),
          // A stall belongs to no request; keep it a root span of its own trace.
          traced(SERVER_STALLED_SPAN, attributes, true),
        );
      }),
    recordSuspectedSystemSleep: (input) =>
      Effect.suspend(() => {
        serverEventSequence += 1;
        const durationMs = Math.max(0, Math.round(input.durationMs));
        const event = {
          type: "suspected-system-sleep" as const,
          sequence: serverEventSequence,
          startedAt: new Date(input.endedAtMs - durationMs).toISOString(),
          endedAt: new Date(input.endedAtMs).toISOString(),
          durationMs,
        };
        serverEvents.push(event);
        const attributes = {
          "event_loop.gap_kind": "system-sleep",
          "event_loop.gap_ms": durationMs,
          "event_loop.gap_started_at": event.startedAt,
          "event_loop.gap_ended_at": event.endedAt,
        };
        // Warning, not info: on macOS and Windows a long low-CPU blocking call looks the same.
        return Effect.logWarning("server event loop paused; suspected system sleep").pipe(
          Effect.annotateLogs(attributes),
          traced(SUSPECTED_SYSTEM_SLEEP_SPAN, attributes, true),
        );
      }),
    recordDeliverySessionEnded: (input) =>
      Effect.suspend(() => {
        serverEventSequence += 1;
        serverEvents.push({
          type: "delivery-session-ended",
          sequence: serverEventSequence,
          at: now().toISOString(),
          consumerId: input.consumerId,
          reason: input.reason,
          durationMs: Math.max(0, Math.round(input.durationMs)),
        });
        const attributes = {
          "delivery.consumer_id": input.consumerId,
          "delivery.end_reason": input.reason,
          "delivery.duration_ms": Math.round(input.durationMs),
        };
        return Effect.logInfo("orchestration delivery session ended").pipe(
          Effect.annotateLogs(attributes),
          traced(DELIVERY_SESSION_ENDED_SPAN, attributes),
        );
      }),
    recordEventLoopWindow: (window) =>
      Effect.sync(() => {
        eventLoop = window;
      }),
    snapshot: (limit) =>
      Effect.sync(() => {
        const bounded = Math.min(
          limit ?? WS_CONNECTION_DIAGNOSTICS_READ_DEFAULT_LIMIT,
          WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT,
        );
        return {
          capturedAt: now().toISOString(),
          reports: reports.newest(bounded),
          serverEvents: serverEvents.newest(bounded),
          eventLoop,
        };
      }),
    markServerShuttingDown: Effect.sync(() => {
      serverShuttingDown = true;
    }),
    isServerShuttingDown: () => serverShuttingDown,
  };
};

export const ConnectionDiagnosticsLive = Layer.sync(ConnectionDiagnostics, () =>
  makeConnectionDiagnostics(),
);
