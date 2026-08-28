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

export type WsAutoReconnectTrigger = "focus" | "online";

export function shouldAutoReconnect(
  status: WsConnectionStatus,
  trigger: WsAutoReconnectTrigger,
): boolean {
  const uiState = getWsConnectionUiState(status);

  if (trigger === "online") {
    return (
      uiState === "offline" ||
      uiState === "reconnecting" ||
      uiState === "error" ||
      status.reconnectPhase === "exhausted"
    );
  }

  return (
    status.online &&
    status.hasConnected &&
    (uiState === "reconnecting" || status.reconnectPhase === "exhausted")
  );
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

export function shouldContinueDesktopStartupReconnect(
  startup: DesktopBackendStartupState | null,
): boolean {
  return startup?.status === "starting" || startup?.status === "upgrading";
}

export function shouldReconnectAfterDesktopStartupTransition(
  isDesktop: boolean,
  previous: DesktopBackendStartupState | null,
  current: DesktopBackendStartupState | null,
): boolean {
  if (!isDesktop || !previous || !current) return false;
  if (
    previous.status === "timedOut" &&
    current.status === "ready" &&
    previous.generation === current.generation
  ) {
    return true;
  }
  return (
    previous.status === "failed" &&
    (current.status === "starting" || current.status === "upgrading") &&
    current.generation > previous.generation
  );
}
