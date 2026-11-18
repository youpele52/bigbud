import { resolveServerUrl } from "../lib/utils";
import { waitForDesktopBackendReady } from "./desktopBackendReady";
import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";
import { markWsInboundActivity } from "./wsActivity";
import {
  getWsConnectionStatus,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  recordWsProtocolRecovery,
  recordWsReconnectScheduled,
} from "./wsConnectionState";

/** An explicit backend owner supplies every observer and its own readiness/URL resolver.
 * In particular, an explicit scope never falls back to the local desktop bridge or atoms. */
export interface WsTransportScope {
  readonly resolveUrl: (url: string | undefined, signal: AbortSignal) => Promise<string>;
  readonly reconnectAttempt: () => number;
  readonly onAttempt: (url: string) => void;
  readonly onOpen: () => void;
  readonly onError: (message: string) => void;
  readonly onClose: (details: { readonly code: number; readonly reason: string }) => void;
  readonly recordReconnectScheduled: (delayMs: number) => void;
  readonly recordProtocolRecovery: () => void;
  readonly trackRpcRequestSent: (requestId: string, tag: string) => void;
  readonly acknowledgeRpcRequest: (requestId: string) => void;
  readonly clearAllTrackedRpcRequests: () => void;
  readonly markWsInboundActivity: () => void;
  readonly dispose: () => void;
}

/** Compatibility scope for the existing single local backend. */
export const localWsTransportScope: WsTransportScope = {
  resolveUrl: async (url, signal) => {
    await waitForDesktopBackendReady(undefined, signal, { waitForRestart: true });
    return resolveServerUrl({
      url,
      protocol: window.location.protocol === "https:" ? "wss" : "ws",
      pathname: "/ws",
    });
  },
  reconnectAttempt: () => getWsConnectionStatus().reconnectAttemptCount,
  onAttempt: recordWsConnectionAttempt,
  onOpen: recordWsConnectionOpened,
  onError: (message) => {
    clearAllTrackedRpcRequests();
    recordWsConnectionErrored(message);
  },
  onClose: (details) => {
    clearAllTrackedRpcRequests();
    recordWsConnectionClosed(details);
  },
  recordReconnectScheduled: recordWsReconnectScheduled,
  recordProtocolRecovery: recordWsProtocolRecovery,
  trackRpcRequestSent,
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  markWsInboundActivity,
  dispose: () => {},
};
