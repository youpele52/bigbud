import { useEffect, useRef } from "react";

import {
  retryServerConfigSync,
  useServerConfigReadiness,
  type ServerConfigReadiness,
} from "../rpc/serverConfigReadiness";
import { reconnectServerConfig } from "../rpc/serverConfigRecovery";
import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import { toastManager } from "./ui/toast";

export interface ConfigRecoveryToast {
  readonly type: "warning" | "info";
  readonly title: string;
  readonly description: string;
  readonly timeout: 0;
  readonly actionProps: { readonly children: string; readonly onClick: () => void };
  readonly data: { readonly hideCopyButton: true };
}

/** Starts only an explicit reconnect and reports failures without rendering raw error values. */
export function reconnectConfigurationFromUi(): void {
  void reconnectServerConfig().catch(() => {
    toastManager.add({
      type: "error",
      title: "Reconnect failed",
      description: "Unable to reconnect to the bigbud server. Try again when it is available.",
      data: { hideCopyButton: true, dismissAfterVisibleMs: 8_000 },
    });
  });
}

/** Keeps one nonblocking notice until configuration updates are genuinely live again. */
export function syncConfigRecoveryToast<TToastId>(
  manager: {
    readonly add: (toast: ConfigRecoveryToast) => TToastId;
    readonly update: (id: TToastId, toast: ConfigRecoveryToast) => void;
    readonly close: (id: TToastId) => void;
  },
  id: TToastId | null,
  readiness: ServerConfigReadiness,
  connected: boolean,
  retry: () => void,
): TToastId | null {
  if (!readiness.hasSnapshot || readiness.stream === "live") {
    if (id !== null) manager.close(id);
    return null;
  }
  const exhausted = readiness.stream === "exhausted";
  if (!exhausted && id === null) return null;
  const toast: ConfigRecoveryToast = {
    type: exhausted ? "warning" : "info",
    title: exhausted ? "Configuration updates paused" : "Restoring configuration updates",
    description: exhausted
      ? "The last valid configuration is still available. Retry to resume provider and settings updates."
      : "The last valid configuration remains available while updates reconnect.",
    timeout: 0,
    actionProps: { children: connected ? "Retry configuration" : "Reconnect", onClick: retry },
    data: { hideCopyButton: true },
  };
  if (id !== null) {
    manager.update(id, toast);
    return id;
  }
  return manager.add(toast);
}

export function useServerConfigRecoveryNotice(status: WsConnectionStatus): void {
  const readiness = useServerConfigReadiness();
  const id = useRef<ReturnType<typeof toastManager.add> | null>(null);
  useEffect(() => {
    const connected = status.phase === "connected";
    id.current = syncConfigRecoveryToast(
      toastManager,
      id.current,
      readiness,
      connected,
      connected ? () => retryServerConfigSync() : reconnectConfigurationFromUi,
    );
  }, [readiness, status.phase]);
  useEffect(
    () => () => {
      if (id.current !== null) {
        toastManager.close(id.current);
        id.current = null;
      }
    },
    [],
  );
}
