import type { ServerStalledPayload } from "@bigbud/contracts/server/connectionDiagnostics.ts";

import { APP_SERVER_NAME } from "../config/branding";
import { formatWsReconnectAttempt, type WsConnectionStatus } from "../rpc/wsConnectionState";
import { formatConnectionMoment } from "./WebSocketConnectionSurface.blocking";

export const RECOVERED_TOAST_VISIBLE_MS = 8_000;

function formatRetryCountdown(nextRetryAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(nextRetryAt).getTime() - nowMs);
  return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

export function describeReconnectingToast(status: WsConnectionStatus, nowMs: number): string {
  const attemptLabel = `Attempt ${formatWsReconnectAttempt(status)}`;
  return status.nextRetryAt === null || status.reconnectPhase !== "waiting"
    ? `Reconnecting... ${attemptLabel}`
    : `Reconnecting in ${formatRetryCountdown(status.nextRetryAt, nowMs)}... ${attemptLabel}`;
}

export function describeRecoveredToast(
  previousDisconnectedAt: string | null,
  connectedAt: string | null,
): string {
  const reconnectedAtLabel = formatConnectionMoment(connectedAt);
  const disconnectedAtLabel = formatConnectionMoment(previousDisconnectedAt);

  if (disconnectedAtLabel && reconnectedAtLabel) {
    return `Disconnected at ${disconnectedAtLabel} and reconnected at ${reconnectedAtLabel}.`;
  }

  if (reconnectedAtLabel) {
    return `Connection restored at ${reconnectedAtLabel}.`;
  }

  return "Connection restored.";
}

/** Explains a drop after the fact from a `stalled` report; never a live "stalled now" state. */
export function describeServerStall(payload: ServerStalledPayload): string {
  const seconds = Math.max(1, Math.round(payload.durationMs / 1000));
  const culprit = payload.spans[0]?.name ?? payload.inFlightRpcMethods[0];
  const work = culprit ? ` while running ${culprit}` : "";
  return `${APP_SERVER_NAME} was busy for ${seconds}s${work}, so this was not a network problem.`;
}

/** Blue while reconnecting: retries never stop, so a transport drop is never shown in red. */
export function buildReconnectingToast(
  status: WsConnectionStatus,
  nowMs: number,
  onRetryNow: () => void,
) {
  return {
    actionProps: {
      children: "Retry now",
      onClick: onRetryNow,
    },
    description: describeReconnectingToast(status, nowMs),
    timeout: 0,
    title: `Disconnected from ${APP_SERVER_NAME}`,
    type: "loading" as const,
    data: {
      icon: "wifi" as const,
      hideCopyButton: true,
    },
  };
}

export function buildOfflineToast() {
  return {
    description: "WebSocket disconnected. Waiting for network.",
    timeout: 0,
    title: "Offline",
    type: "warning" as const,
    data: {
      hideCopyButton: true,
    },
  };
}

export function buildRecoveredToast(
  previousDisconnectedAt: string | null,
  connectedAt: string | null,
  stall: ServerStalledPayload | null = null,
) {
  const recovered = describeRecoveredToast(previousDisconnectedAt, connectedAt);
  return {
    description: stall ? `${describeServerStall(stall)} ${recovered}` : recovered,
    title: `Reconnected to ${APP_SERVER_NAME}`,
    type: "success" as const,
    timeout: 0,
    data: {
      dismissAfterVisibleMs: RECOVERED_TOAST_VISIBLE_MS,
      hideCopyButton: true,
    },
  };
}

/** Amber: the manual restart failed, but automatic retries continue in the background. */
export function buildManualReconnectFailedToast() {
  return {
    type: "warning" as const,
    title: "Reconnect failed",
    description: `Unable to restart the WebSocket. ${APP_SERVER_NAME} keeps retrying automatically.`,
    data: {
      dismissAfterVisibleMs: RECOVERED_TOAST_VISIBLE_MS,
      hideCopyButton: true,
    },
  };
}
