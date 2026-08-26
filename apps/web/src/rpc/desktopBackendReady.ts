import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";

type DesktopBackendReadyBridge = Pick<
  DesktopBridge,
  "getBackendStartupState" | "onBackendStartupState"
>;

const noop = () => undefined;

function isReady(state: DesktopBackendStartupState): boolean {
  return state.status === "ready";
}

export class DesktopBackendStartupError extends Error {
  readonly _tag = "DesktopBackendStartupError";

  constructor(readonly state: DesktopBackendStartupState) {
    super(`Desktop backend startup failed (${state.failureReason ?? "unknown"}).`);
    this.name = "DesktopBackendStartupError";
  }
}

/**
 * The desktop bridge publishes its WebSocket URL before the backend starts so
 * startup UI can render immediately. Wait for the backend's fd4 readiness
 * signal before allowing the RPC layer to construct a socket.
 */
export function waitForDesktopBackendReady(
  bridge: DesktopBackendReadyBridge | undefined = typeof window === "undefined"
    ? undefined
    : window.desktopBridge,
  signal?: AbortSignal,
): Promise<void> {
  if (!bridge?.getBackendStartupState || !bridge.onBackendStartupState) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let receivedUpdate = false;
    let unsubscribe: (() => void) | undefined;
    let abort = noop;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    abort = () => {
      const error = new Error("Desktop backend readiness wait was cancelled.");
      error.name = "AbortError";
      finish(error);
    };
    const applyState = (state: DesktopBackendStartupState) => {
      if (isReady(state)) finish();
      else if (state.status === "failed") finish(new DesktopBackendStartupError(state));
    };
    unsubscribe = bridge.onBackendStartupState((state) => {
      receivedUpdate = true;
      applyState(state);
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    void bridge
      .getBackendStartupState()
      .then((state) => {
        if (!receivedUpdate) applyState(state);
      })
      .catch(() => {
        // Keep waiting for the subscribed authoritative state update.
      });
  });
}
