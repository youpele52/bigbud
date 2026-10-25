import type {
  OrchestrationDeliverySessionEndReason,
  ServerConnectionDiagnosticsEvent,
  ServerEventLoopWindow,
  ServerWsConnectionDiagnosticsSnapshot,
  WsConnectionDiagnosticsReportEntry,
} from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { WS_CONNECTION_DIAGNOSTICS_PAGE_LOAD_REASON } from "@bigbud/contracts/constants/connectionDiagnostics.constant.ts";

export const CONNECTION_TRANSITION_LIMIT = 20;

/** Matches the app's status colors: blue in progress, green done, amber warning, red failure. */
export type ConnectionTransitionTone = "info" | "success" | "warning" | "error";

export interface ConnectionTransitionRow {
  readonly id: string;
  readonly at: string;
  readonly atMs: number;
  readonly label: string;
  readonly source: "app" | "server";
  readonly tone: ConnectionTransitionTone;
  readonly details: ReadonlyArray<string>;
}

const REPORT_LABELS: Record<
  WsConnectionDiagnosticsReportEntry["trigger"],
  { label: string; tone: ConnectionTransitionTone }
> = {
  connect: { label: "Connected", tone: "success" },
  "reconnect-success": { label: "Reconnected", tone: "success" },
  close: { label: "Connection closed", tone: "warning" },
  error: { label: "Connection error", tone: "error" },
  "heartbeat-failure": { label: "Heartbeat missed", tone: "warning" },
  "protocol-failure": { label: "Protocol failure", tone: "error" },
};

const END_REASON_LABELS: Record<
  OrchestrationDeliverySessionEndReason,
  { label: string; tone: ConnectionTransitionTone }
> = {
  "client-close": { label: "closed by the app", tone: "info" },
  overflow: { label: "fell behind and was reset", tone: "warning" },
  "handoff-ended": { label: "live feed ended", tone: "warning" },
  "server-shutdown": { label: "server shut down", tone: "warning" },
  superseded: { label: "replaced by a newer connection", tone: "info" },
  "session-failed": { label: "failed", tone: "error" },
};

export function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)} min ${Math.round((durationMs % 60_000) / 1_000)} s`;
}

const toMs = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};

function reportRow(report: WsConnectionDiagnosticsReportEntry): ConnectionTransitionRow {
  const isPageLoad = report.reason === WS_CONNECTION_DIAGNOSTICS_PAGE_LOAD_REASON;
  const presentation = isPageLoad
    ? { label: "Page loaded", tone: "info" as const }
    : REPORT_LABELS[report.trigger];
  const at = report.occurredAt ?? report.receivedAt;
  const details = [
    report.closeCode === undefined ? null : `Code ${report.closeCode}`,
    report.closeReason ? report.closeReason : null,
    report.reason && !isPageLoad ? `Reason: ${report.reason}` : null,
    report.attempt > 0 ? `Attempt ${report.attempt}` : null,
    report.msSinceLastInboundEvent === undefined || report.msSinceLastInboundEvent === null
      ? null
      : `Last message ${formatDurationMs(report.msSinceLastInboundEvent)} before`,
    report.detail ? report.detail : null,
    report.consumerId ? `Window ${report.consumerId}` : null,
  ].filter((entry): entry is string => entry !== null);
  return {
    id: `report-${report.sequence}`,
    at,
    atMs: toMs(at),
    source: "app",
    ...presentation,
    details,
  };
}

function serverEventRow(event: ServerConnectionDiagnosticsEvent): ConnectionTransitionRow {
  if (event.type === "stalled") {
    const running = event.payload.spans.map((span) => span.name);
    return {
      id: `server-${event.sequence}`,
      at: event.payload.endedAt,
      atMs: toMs(event.payload.endedAt),
      source: "server",
      label: `Server stalled for ${formatDurationMs(event.payload.durationMs)}`,
      tone: "warning",
      details: running.length > 0 ? [`Running: ${running.join(", ")}`] : [],
    };
  }
  if (event.type === "suspected-system-sleep") {
    return {
      id: `server-${event.sequence}`,
      at: event.endedAt,
      atMs: toMs(event.endedAt),
      source: "server",
      label: `Server paused for ${formatDurationMs(event.durationMs)}, likely system sleep`,
      tone: "info",
      details: ["Not counted as a stall. A long blocking call can look the same on Windows."],
    };
  }
  const presentation = END_REASON_LABELS[event.reason];
  return {
    id: `server-${event.sequence}`,
    at: event.at,
    atMs: toMs(event.at),
    source: "server",
    label: `Live updates ${presentation.label}`,
    tone: presentation.tone,
    details: [`After ${formatDurationMs(event.durationMs)}`, `Window ${event.consumerId}`],
  };
}

/** Merges app reports and server events into one newest-first list. */
export function buildConnectionTransitionRows(
  snapshot: ServerWsConnectionDiagnosticsSnapshot,
  limit = CONNECTION_TRANSITION_LIMIT,
): ReadonlyArray<ConnectionTransitionRow> {
  return [...snapshot.reports.map(reportRow), ...snapshot.serverEvents.map(serverEventRow)]
    .toSorted((left, right) => right.atMs - left.atMs)
    .slice(0, limit);
}

export function describeEventLoopWindow(window: ServerEventLoopWindow | null): string {
  if (!window) return "No measurement yet.";
  const stalls = window.stallCount === 1 ? "1 stall" : `${window.stallCount} stalls`;
  return `p99 ${formatDurationMs(window.p99Ms)}, max ${formatDurationMs(window.maxMs)}, ${stalls} in the last ${formatDurationMs(window.windowMs)}.`;
}
