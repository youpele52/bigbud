import { getWsConnectionUiState, type WsConnectionStatus } from "../rpc/wsConnectionState";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";

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

export function shouldReconnectAfterTimedOutDesktopStartup(
  isDesktop: boolean,
  previous: DesktopBackendStartupState | null,
  current: DesktopBackendStartupState | null,
): boolean {
  return (
    isDesktop &&
    previous?.status === "timedOut" &&
    current?.status === "ready" &&
    previous.generation === current.generation
  );
}
