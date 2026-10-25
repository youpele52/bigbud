import { getWsConnectionUiState, type WsConnectionStatus } from "../rpc/wsConnectionState";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import type { OrchestrationDeliveryLifecycle } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";

type DeliveryRecoveryToast = {
  readonly type: "error" | "info" | "warning";
  readonly title: string;
  readonly description: string;
  readonly timeout: 0;
  readonly data: { readonly hideCopyButton: true };
};

export function syncDeliveryRecoveryToast<TToastId>(
  manager: {
    readonly add: (toast: DeliveryRecoveryToast) => TToastId;
    readonly update: (toastId: TToastId, toast: DeliveryRecoveryToast) => void;
    readonly close: (toastId: TToastId) => void;
  },
  toastId: TToastId | null,
  delivery: OrchestrationDeliveryLifecycle | null,
): TToastId | null {
  if (!delivery || delivery.state === "live") {
    if (toastId !== null) manager.close(toastId);
    return null;
  }
  if (delivery.state === "connecting" && toastId === null) return null;
  const fallback = delivery.state === "fallback";
  const incompatible = delivery.state === "incompatible";
  const restoringBaseline =
    delivery.reasonCode === "replay_budget_exceeded" ||
    delivery.reasonCode === "replay_unavailable";
  const toast: DeliveryRecoveryToast = {
    type: incompatible ? "error" : fallback ? "warning" : "info",
    title: incompatible
      ? "Desktop delivery supervisor is incompatible"
      : fallback
        ? "Event delivery is degraded"
        : "Restoring event delivery",
    description: incompatible
      ? "Update bigbud to restore desktop event delivery."
      : fallback
        ? "This session is using the fenced TypeScript fallback."
        : restoringBaseline
          ? "Restoring current state before event delivery resumes."
          : "The desktop delivery supervisor is reconnecting from the last applied event.",
    timeout: 0,
    data: { hideCopyButton: true },
  };
  if (toastId !== null) {
    manager.update(toastId, toast);
    return toastId;
  }
  return manager.add(toast);
}

/** Signals that should skip the current backoff wait and try again immediately. */
export type WsAutoReconnectTrigger = "focus" | "online" | "visible" | "resume" | "unlock" | "ready";

export function shouldAutoReconnect(
  status: WsConnectionStatus,
  trigger: WsAutoReconnectTrigger,
): boolean {
  const uiState = getWsConnectionUiState(status);
  if (uiState === "connected") return false;

  if (trigger === "focus") {
    // Focus is frequent; only nudge a link that was live before.
    return status.online && status.hasConnected && uiState === "reconnecting";
  }

  // Wake, unlock, visibility, network and backend readiness are definite reasons to retry.
  return uiState === "offline" || uiState === "reconnecting" || uiState === "error";
}

export function shouldRestartStalledReconnect(
  status: WsConnectionStatus,
  expectedNextRetryAt: string,
): boolean {
  return (
    status.reconnectPhase === "waiting" &&
    status.nextRetryAt === expectedNextRetryAt &&
    status.online &&
    status.hasConnected
  );
}

export function shouldShowDesktopStartupBlockingState(
  startup: DesktopBackendStartupState | null,
): boolean {
  return startup?.status === "failed" || startup?.status === "timedOut";
}

/**
 * `replace-session` rebuilds a session whose readiness wait failed; `skip-backoff` only cuts
 * the current reconnect wait, so a connecting socket is never abandoned.
 */
export type DesktopStartupReconnect = "replace-session" | "skip-backoff";

export function resolveDesktopStartupReconnect(
  isDesktop: boolean,
  previous: DesktopBackendStartupState | null,
  current: DesktopBackendStartupState | null,
): DesktopStartupReconnect | null {
  if (!isDesktop || !previous || !current) return null;
  if (
    previous.status === "timedOut" &&
    current.status === "ready" &&
    previous.generation === current.generation
  ) {
    return "replace-session";
  }
  if (
    previous.status === "failed" &&
    (current.status === "starting" || current.status === "upgrading") &&
    current.generation > previous.generation
  ) {
    return "replace-session";
  }
  // Any other arrival at `ready`, including a republished `ready` after wake.
  return current.status === "ready" ? "skip-backoff" : null;
}

export function shouldReconnectAfterDesktopStartupTransition(
  isDesktop: boolean,
  previous: DesktopBackendStartupState | null,
  current: DesktopBackendStartupState | null,
): boolean {
  return resolveDesktopStartupReconnect(isDesktop, previous, current) !== null;
}
