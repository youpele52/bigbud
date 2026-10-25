import { type ReactNode, useEffect, useState } from "react";

import { useServerConfig } from "../rpc/serverState";
import { useServerConfigReadiness } from "../rpc/serverConfigReadiness";
import { getWsConnectionUiState, useWsConnectionStatus } from "../rpc/wsConnectionState";
import { shouldShowDesktopStartupBlockingState } from "./WebSocketConnectionSurface.logic";
import { WebSocketBlockingState } from "./WebSocketConnectionSurface.blocking";
import { useDesktopBackendStartupState } from "./DesktopBackendStartupCoordinator";

const BLOCKING_STATE_DELAY_MS = 60_000;

export function WebSocketConnectionSurface({ children }: { readonly children: ReactNode }) {
  const serverConfig = useServerConfig();
  const readiness = useServerConfigReadiness();
  const status = useWsConnectionStatus();
  const desktopStartup = useDesktopBackendStartupState();
  const [delayElapsed, setDelayElapsed] = useState(false);

  useEffect(() => {
    // Config survives reconnects; this grace period is only for the first snapshot.
    setDelayElapsed(false);
    if (serverConfig !== null) return;
    const id = window.setTimeout(() => setDelayElapsed(true), BLOCKING_STATE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [serverConfig]);

  const confirmedFailure = readiness.fallback === "failed" || readiness.stream === "exhausted";
  if (
    desktopStartup?.ownershipRecovery?.phase === "yielded" ||
    (serverConfig === null &&
      (delayElapsed || confirmedFailure || shouldShowDesktopStartupBlockingState(desktopStartup)))
  ) {
    return (
      <WebSocketBlockingState
        status={status}
        uiState={getWsConnectionUiState(status)}
        desktopStartup={desktopStartup}
        configReadiness={readiness}
      />
    );
  }

  return children;
}
