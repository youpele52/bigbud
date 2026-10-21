import {
  WS_CONNECTION_DIAGNOSTICS_PAGE_LOAD_REASON,
  WS_CONNECTION_DIAGNOSTICS_TEXT_MAX_LENGTH,
} from "@bigbud/contracts/constants/connectionDiagnostics.constant.ts";
import type {
  WsConnectionDiagnosticsReport,
  WsConnectionDiagnosticsTrigger,
} from "@bigbud/contracts/server/connectionDiagnostics.ts";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Duration, Option } from "effect";

import { peekDeliveryConsumerId } from "./orchestrationDeliveryCursor";
import { getMsSinceLastWsInboundActivity } from "./wsActivity";
import { getWsConnectionStatus } from "./wsConnectionState";
import type { WsOpenDetails, WsProtocolLifecycleHandlers } from "./protocol";
import { isOptionalWsRpcUnsupported } from "./protocol.optionalRpc";
import type { WsTransport } from "./wsTransport";
import { isUnknownRequestTagError } from "./wsTransport.errors";

/** Reports wait here while the socket is down; the oldest are dropped past this bound. */
export const WS_CONNECTION_DIAGNOSTICS_MAX_PENDING = 50;
/** A report is offered on at most this many connections, then dropped: no retry loops. */
export const WS_CONNECTION_DIAGNOSTICS_MAX_SEND_ATTEMPTS = 3;

const WS_CONNECTION_DIAGNOSTICS_SEND_TIMEOUT = Option.some(Duration.seconds(5));
const REPORT_METHOD = WS_METHODS.serverReportWsConnectionDiagnostics;

type ReportSender = (report: WsConnectionDiagnosticsReport) => Promise<unknown>;

interface ReportInput {
  readonly trigger: WsConnectionDiagnosticsTrigger;
  /** Overrides the live attempt counter, which an open has already reset. */
  readonly attempt?: number;
  readonly reason?: string;
  readonly closeCode?: number;
  readonly closeReason?: string;
  readonly detail?: string;
}

interface PendingReport {
  readonly report: WsConnectionDiagnosticsReport;
  attempts: number;
}

let pending: PendingReport[] = [];
let sender: ReportSender | null = null;
let flushing = false;
let unsupported = false;
let hasReportedConnect = false;
/**
 * The first failed socket of an outage is reported in full (its error and close); later
 * attempts are only counted, so a long outage cannot flush the original cause out of the queue.
 */
let outagePhase: "none" | "first-drop" | "collapsing" = "none";
let collapsedFailedAttempts = 0;
let lastCollapsedCloseCode: number | undefined;

function boundedText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, WS_CONNECTION_DIAGNOSTICS_TEXT_MAX_LENGTH) : undefined;
}

function buildReport(input: ReportInput): WsConnectionDiagnosticsReport {
  const status = getWsConnectionStatus();
  const consumerId = peekDeliveryConsumerId();
  const reason = boundedText(input.reason);
  const closeReason = boundedText(input.closeReason);
  const detail = boundedText(input.detail);
  return {
    trigger: input.trigger,
    attempt: Math.max(0, input.attempt ?? status.reconnectAttemptCount),
    msSinceLastInboundEvent: getMsSinceLastWsInboundActivity(),
    occurredAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
    ...(input.closeCode === undefined ? {} : { closeCode: input.closeCode }),
    ...(closeReason ? { closeReason } : {}),
    ...(consumerId ? { consumerId } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Sends queued reports in order once connected. Best-effort and fire-and-forget: callers
 * never await it, and a failed report never feeds the heartbeat or triggers a reconnect.
 */
async function flush(): Promise<void> {
  const send = sender;
  if (flushing || isReportingUnsupported() || !send) return;
  if (getWsConnectionStatus().phase !== "connected") return;
  flushing = true;
  try {
    while (pending.length > 0 && !unsupported) {
      // A replaced transport owns the queue from here.
      if (sender !== send) return;
      const entry = pending[0]!;
      entry.attempts += 1;
      try {
        await send(entry.report);
        pending.shift();
      } catch (error) {
        if (isUnknownRequestTagError(error)) {
          // An older server without the report RPC: stop reporting for this page.
          unsupported = true;
          pending = [];
          return;
        }
        // A rejected report, or one that keeps meeting dropped sockets, is discarded.
        if (
          getWsConnectionStatus().phase === "connected" ||
          entry.attempts >= WS_CONNECTION_DIAGNOSTICS_MAX_SEND_ATTEMPTS
        ) {
          pending.shift();
          continue;
        }
        // Disconnected again: keep the rest for the next successful connect.
        return;
      }
    }
  } finally {
    flushing = false;
  }
}

function isReportingUnsupported(): boolean {
  if (!unsupported && isOptionalWsRpcUnsupported(REPORT_METHOD)) {
    unsupported = true;
    pending = [];
  }
  return unsupported;
}

export function queueWsConnectionDiagnosticsReport(input: ReportInput): void {
  if (isReportingUnsupported()) return;
  // `occurredAt` is stamped now, when the event happened, not when it is delivered.
  pending.push({ report: buildReport(input), attempts: 0 });
  if (pending.length > WS_CONNECTION_DIAGNOSTICS_MAX_PENDING) {
    pending.splice(0, pending.length - WS_CONNECTION_DIAGNOSTICS_MAX_PENDING);
  }
  void flush();
}

function collapsedOutageSummary(): string | undefined {
  if (collapsedFailedAttempts === 0) return undefined;
  const closeCode =
    lastCollapsedCloseCode === undefined ? "" : `; lastCloseCode=${lastCollapsedCloseCode}`;
  return `collapsedFailedAttempts=${collapsedFailedAttempts}${closeCode}`;
}

/** The first connect after a navigation is tagged `page-load`, never counted as a reconnect. */
function reportOpened({ reconnectAttempt }: WsOpenDetails): void {
  const detail = collapsedOutageSummary();
  outagePhase = "none";
  collapsedFailedAttempts = 0;
  lastCollapsedCloseCode = undefined;
  const summary = { attempt: reconnectAttempt, ...(detail ? { detail } : {}) };
  if (hasReportedConnect) {
    queueWsConnectionDiagnosticsReport({ trigger: "reconnect-success", ...summary });
    return;
  }
  hasReportedConnect = true;
  queueWsConnectionDiagnosticsReport({
    trigger: "connect",
    reason: WS_CONNECTION_DIAGNOSTICS_PAGE_LOAD_REASON,
    ...summary,
  });
}

function reportDrop(input: ReportInput): void {
  if (outagePhase === "collapsing") {
    if (input.trigger === "close") {
      collapsedFailedAttempts += 1;
      lastCollapsedCloseCode = input.closeCode;
    }
    return;
  }
  outagePhase = "first-drop";
  queueWsConnectionDiagnosticsReport(input);
}

/** Lifecycle hooks for the shared transport; test transports stay silent. */
export const wsConnectionDiagnosticsLifecycle: WsProtocolLifecycleHandlers = {
  onAttempt: () => {
    // A new socket after the first drop: its failures are counted, not reported one by one.
    if (outagePhase === "first-drop") outagePhase = "collapsing";
  },
  onOpen: reportOpened,
  onClose: ({ code, reason }) =>
    reportDrop({ trigger: "close", closeCode: code, closeReason: reason }),
  onError: (message) => reportDrop({ trigger: "error", detail: message }),
  onProtocolFailure: () => queueWsConnectionDiagnosticsReport({ trigger: "protocol-failure" }),
};

/** Sends through the shared transport with a short deadline so a hung report cannot pile up. */
export function attachWsConnectionDiagnosticsTransport(transport: WsTransport): () => void {
  return attachWsConnectionDiagnosticsSender((report) =>
    transport.request((client) => client[WS_METHODS.serverReportWsConnectionDiagnostics](report), {
      timeout: WS_CONNECTION_DIAGNOSTICS_SEND_TIMEOUT,
    }),
  );
}

export function attachWsConnectionDiagnosticsSender(send: ReportSender): () => void {
  sender = send;
  void flush();
  return () => {
    if (sender === send) sender = null;
  };
}

export function resetWsConnectionDiagnosticsReporterForTests(): void {
  pending = [];
  sender = null;
  flushing = false;
  unsupported = false;
  hasReportedConnect = false;
  outagePhase = "none";
  collapsedFailedAttempts = 0;
  lastCollapsedCloseCode = undefined;
}

export function getPendingWsConnectionDiagnosticsReportsForTests(): readonly WsConnectionDiagnosticsReport[] {
  return pending.map((entry) => entry.report);
}
