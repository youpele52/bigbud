import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";
import { socketDiagnosticUrl } from "./wsConnectionDiagnostics";
import { WS_RECONNECT_LABEL_MAX_ATTEMPTS } from "./wsReconnectPolicy";

export type WsConnectionUiState = "connected" | "connecting" | "error" | "offline" | "reconnecting";
/**
 * The transport never gives up, so it never reports `exhausted`. The member stays for
 * compatibility with persisted UI fixtures; presentation derives "past the label cap" instead.
 */
export type WsReconnectPhase = "attempting" | "exhausted" | "idle" | "waiting";

export interface WsConnectionStatus {
  readonly attemptCount: number;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly hasConnected: boolean;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly nextRetryAt: string | null;
  readonly online: boolean;
  readonly phase: "idle" | "connecting" | "connected" | "disconnected";
  readonly reconnectAttemptCount: number;
  readonly reconnectMaxAttempts: number;
  readonly reconnectPhase: WsReconnectPhase;
  readonly socketUrl: string | null;
}

const INITIAL_WS_CONNECTION_STATUS = Object.freeze<WsConnectionStatus>({
  attemptCount: 0,
  closeCode: null,
  closeReason: null,
  connectedAt: null,
  disconnectedAt: null,
  hasConnected: false,
  lastError: null,
  lastErrorAt: null,
  nextRetryAt: null,
  online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  phase: "idle",
  reconnectAttemptCount: 0,
  reconnectMaxAttempts: WS_RECONNECT_LABEL_MAX_ATTEMPTS,
  reconnectPhase: "idle",
  socketUrl: null,
});

export const wsConnectionStatusAtom = Atom.make(INITIAL_WS_CONNECTION_STATUS).pipe(
  Atom.keepAlive,
  Atom.withLabel("ws-connection-status"),
);

function isoNow() {
  return new Date().toISOString();
}

function updateWsConnectionStatus(
  updater: (current: WsConnectionStatus) => WsConnectionStatus,
): WsConnectionStatus {
  const nextStatus = updater(getWsConnectionStatus());
  appAtomRegistry.set(wsConnectionStatusAtom, nextStatus);
  return nextStatus;
}

export function getWsConnectionStatus(): WsConnectionStatus {
  return appAtomRegistry.get(wsConnectionStatusAtom);
}

export function getWsConnectionUiState(status: WsConnectionStatus): WsConnectionUiState {
  if (status.phase === "connected") {
    return "connected";
  }

  if (!status.online && (status.disconnectedAt !== null || status.phase === "disconnected")) {
    return "offline";
  }

  if (!status.hasConnected) {
    return status.phase === "disconnected" ? "error" : "connecting";
  }

  return "reconnecting";
}

/** Past the label cap retries continue, so the label drops the denominator. */
export function isWsReconnectPastLabelCap(status: WsConnectionStatus): boolean {
  return status.reconnectAttemptCount > status.reconnectMaxAttempts;
}

export function formatWsReconnectAttempt(status: WsConnectionStatus): string {
  const attempt = Math.max(1, status.reconnectAttemptCount);
  return isWsReconnectPastLabelCap(status)
    ? `${attempt}`
    : `${attempt}/${status.reconnectMaxAttempts}`;
}

export function isWsReconnecting(status: WsConnectionStatus): boolean {
  return (
    status.hasConnected &&
    getWsConnectionUiState(status) === "reconnecting" &&
    (status.reconnectPhase === "waiting" || status.reconnectPhase === "attempting")
  );
}

export function recordWsConnectionAttempt(socketUrl: string): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    attemptCount: current.attemptCount + 1,
    nextRetryAt: null,
    phase: "connecting",
    reconnectAttemptCount: current.phase === "connected" ? 1 : current.reconnectAttemptCount + 1,
    reconnectPhase: "attempting",
    socketUrl: socketDiagnosticUrl(socketUrl),
  }));
}

export function recordWsConnectionOpened(): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    closeCode: null,
    closeReason: null,
    connectedAt: isoNow(),
    disconnectedAt: null,
    hasConnected: true,
    nextRetryAt: null,
    phase: "connected",
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  }));
}

export function recordWsConnectionErrored(message?: string | null): WsConnectionStatus {
  return updateWsConnectionStatus((current) =>
    applyDisconnectState(current, {
      lastError: message?.trim() ? message : current.lastError,
      lastErrorAt: isoNow(),
    }),
  );
}

export function recordWsConnectionClosed(details?: {
  readonly code?: number;
  readonly reason?: string;
}): WsConnectionStatus {
  return updateWsConnectionStatus((current) =>
    applyDisconnectState(current, {
      closeCode: details?.code ?? current.closeCode,
      closeReason: details?.reason?.trim() ? details.reason : current.closeReason,
    }),
  );
}

export function setBrowserOnlineStatus(online: boolean): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    online,
  }));
}

export function resetWsReconnectBackoff(): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  }));
}

/** Publishes the jittered delay the socket schedule actually chose, for the toast countdown. */
export function recordWsReconnectScheduled(delayMs: number): WsConnectionStatus {
  return updateWsConnectionStatus((current) =>
    current.phase === "connected"
      ? current
      : {
          ...current,
          nextRetryAt: new Date(Date.now() + Math.max(0, delayMs)).toISOString(),
          reconnectPhase: "waiting",
        },
  );
}

/** Protocol retirement owns its recovery schedule, rather than the stalled-socket watchdog. */
export function recordWsProtocolRecovery(): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    phase: "disconnected",
    disconnectedAt: current.disconnectedAt ?? isoNow(),
    lastError: "WebSocket RPC session failed.",
    lastErrorAt: isoNow(),
    nextRetryAt: null,
    reconnectPhase: "attempting",
  }));
}

export function resetWsConnectionStateForTests(): void {
  appAtomRegistry.set(wsConnectionStatusAtom, INITIAL_WS_CONNECTION_STATUS);
}

export function useWsConnectionStatus(): WsConnectionStatus {
  return useAtomValue(wsConnectionStatusAtom);
}

function applyDisconnectState(
  current: WsConnectionStatus,
  updates: Partial<
    Pick<WsConnectionStatus, "closeCode" | "closeReason" | "lastError" | "lastErrorAt">
  >,
): WsConnectionStatus {
  // The socket schedule records the real jittered delay once it picks one.
  return {
    ...current,
    ...updates,
    disconnectedAt: current.disconnectedAt ?? isoNow(),
    phase: "disconnected",
    reconnectPhase: "waiting",
  };
}
