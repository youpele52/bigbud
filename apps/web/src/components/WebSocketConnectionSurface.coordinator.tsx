import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  setBrowserOnlineStatus,
  type WsConnectionUiState,
  useWsConnectionStatus,
} from "../rpc/wsConnectionState";
import { getWsRpcClient } from "../rpc/wsRpcClient";
import { useOrchestrationDeliveryLifecycle } from "../rpc/orchestrationDeliveryState";
import {
  shouldAutoReconnect,
  shouldRestartStalledReconnect,
  syncDeliveryRecoveryToast,
  type WsAutoReconnectTrigger,
} from "./WebSocketConnectionSurface.logic";
import { useWebSocketHeartbeat } from "./WebSocketConnectionSurface.heartbeat";
import { useWebSocketReconnectTriggers } from "./WebSocketConnectionSurface.triggers";
import {
  buildServerStallExplanationToast,
  useServerStallExplanation,
} from "./WebSocketConnectionSurface.stall";
import {
  buildManualReconnectFailedToast,
  buildOfflineToast,
  buildReconnectingToast,
  buildRecoveredToast,
  RECOVERED_TOAST_VISIBLE_MS,
} from "./WebSocketConnectionSurface.toasts";
import { toastManager } from "./ui/toast";
import type { ThreadToastData } from "./ui/toast.manager";
import { useServerConfigRecoveryNotice } from "./WebSocketConnectionSurface.configRecovery";
import { reconnectServerConfig } from "../rpc/serverConfigRecovery";

const FORCED_WS_RECONNECT_DEBOUNCE_MS = 5_000;

export function WebSocketConnectionCoordinator() {
  const status = useWsConnectionStatus();
  useServerConfigRecoveryNotice(status);
  const delivery = useOrchestrationDeliveryLifecycle();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastForcedReconnectAtRef = useRef(0);
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const deliveryToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const toastResetTimerRef = useRef<number | null>(null);
  const previousUiStateRef = useRef<WsConnectionUiState>(getWsConnectionUiState(status));
  const previousDisconnectedAtRef = useRef<string | null>(status.disconnectedAt);
  const recoveredToastArgsRef = useRef<readonly [string | null, string | null] | null>(null);
  // A stall report arrives only after the freeze ends: fold it into the visible recovery
  // toast, or explain the earlier drop in a separate blue note once that toast is gone.
  const stallExplanation = useServerStallExplanation((stall) => {
    const recoveredArgs = recoveredToastArgsRef.current;
    if (toastIdRef.current && toastResetTimerRef.current !== null && recoveredArgs) {
      toastManager.update(toastIdRef.current, buildRecoveredToast(...recoveredArgs, stall));
      return;
    }
    toastManager.add(buildServerStallExplanationToast(stall));
  });

  useEffect(() => {
    deliveryToastIdRef.current = syncDeliveryRecoveryToast(
      toastManager,
      deliveryToastIdRef.current,
      delivery,
    );
  }, [delivery]);

  const runReconnect = useEffectEvent((showFailureToast: boolean) => {
    invalidateHeartbeat();
    if (toastResetTimerRef.current !== null) {
      window.clearTimeout(toastResetTimerRef.current);
      toastResetTimerRef.current = null;
    }
    lastForcedReconnectAtRef.current = Date.now();
    const reconnect = showFailureToast ? reconnectServerConfig() : getWsRpcClient().reconnect();
    void reconnect.catch(() => {
      if (!showFailureToast) {
        console.warn("Automatic WebSocket reconnect failed");
        return;
      }
      toastManager.add(buildManualReconnectFailedToast());
    });
  });

  const heartbeat = useWebSocketHeartbeat(status.phase === "connected", () => {
    runReconnect(false);
  });
  const invalidateHeartbeat = heartbeat.invalidate;

  const syncBrowserOnlineStatus = useEffectEvent(() => {
    setBrowserOnlineStatus(navigator.onLine !== false);
  });

  const triggerManualReconnect = useEffectEvent(() => {
    runReconnect(true);
  });

  const triggerAutoReconnect = useEffectEvent((trigger: WsAutoReconnectTrigger) => {
    const currentStatus =
      trigger === "online" ? setBrowserOnlineStatus(true) : getWsConnectionStatus();

    if (currentStatus.phase === "connected") {
      // A socket that looks open after a wake may be dead; confirm it now.
      if (trigger !== "focus") heartbeat.probeNow();
      return;
    }
    if (!shouldAutoReconnect(currentStatus, trigger)) {
      return;
    }
    // Skip the current backoff wait without abandoning the session.
    if (getWsRpcClient().reconnectNow()) return;
    // Storm guard: an upgrade is already in flight, so let it finish.
    if (currentStatus.reconnectPhase === "attempting") return;
    if (Date.now() - lastForcedReconnectAtRef.current < FORCED_WS_RECONNECT_DEBOUNCE_MS) {
      return;
    }

    runReconnect(false);
  });

  useEffect(() => {
    syncBrowserOnlineStatus();
  }, []);

  useWebSocketReconnectTriggers({
    onTrigger: triggerAutoReconnect,
    onOffline: (source) => {
      if (source === "desktop") setBrowserOnlineStatus(false);
      else syncBrowserOnlineStatus();
    },
    onSleepBoundary: () => {
      invalidateHeartbeat();
    },
  });

  useEffect(() => {
    if (status.reconnectPhase !== "waiting" || status.nextRetryAt === null) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [status.nextRetryAt, status.reconnectPhase]);

  useEffect(() => {
    if (
      status.reconnectPhase !== "waiting" ||
      status.nextRetryAt === null ||
      !status.online ||
      !status.hasConnected
    ) {
      return;
    }

    const nextRetryAt = status.nextRetryAt;
    const timeoutMs = Math.max(0, new Date(nextRetryAt).getTime() - Date.now()) + 1_500;
    const timeoutId = window.setTimeout(() => {
      const currentStatus = getWsConnectionStatus();
      if (!shouldRestartStalledReconnect(currentStatus, nextRetryAt)) {
        return;
      }

      runReconnect(false);
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [status.hasConnected, status.nextRetryAt, status.online, status.reconnectPhase]);

  useEffect(() => {
    const uiState = getWsConnectionUiState(status);
    const previousUiState = previousUiStateRef.current;
    const previousDisconnectedAt = previousDisconnectedAtRef.current;
    const shouldShowReconnectToast = status.hasConnected && uiState === "reconnecting";
    const shouldShowOfflineToast = uiState === "offline" && status.disconnectedAt !== null;

    if (
      toastResetTimerRef.current !== null &&
      (shouldShowReconnectToast || shouldShowOfflineToast)
    ) {
      window.clearTimeout(toastResetTimerRef.current);
      toastResetTimerRef.current = null;
    }

    if (shouldShowReconnectToast || shouldShowOfflineToast) {
      const toastPayload = shouldShowOfflineToast
        ? buildOfflineToast()
        : buildReconnectingToast(status, nowMs, triggerManualReconnect);

      if (toastIdRef.current) {
        toastManager.update<ThreadToastData>(toastIdRef.current, toastPayload);
      } else {
        toastIdRef.current = toastManager.add<ThreadToastData>(toastPayload);
      }
    } else if (toastIdRef.current) {
      toastManager.close(toastIdRef.current);
      toastIdRef.current = null;
    }

    if (
      uiState === "connected" &&
      (previousUiState === "offline" || previousUiState === "reconnecting") &&
      previousDisconnectedAt !== null
    ) {
      const stall = stallExplanation.explainRecovery({
        disconnectedAt: previousDisconnectedAt,
        reconnectedAt: status.connectedAt,
      });
      recoveredToastArgsRef.current = [previousDisconnectedAt, status.connectedAt];
      const successToast = buildRecoveredToast(previousDisconnectedAt, status.connectedAt, stall);

      if (toastIdRef.current) {
        toastManager.update(toastIdRef.current, successToast);
      } else {
        toastIdRef.current = toastManager.add(successToast);
      }

      toastResetTimerRef.current = window.setTimeout(() => {
        toastIdRef.current = null;
        toastResetTimerRef.current = null;
        recoveredToastArgsRef.current = null;
      }, RECOVERED_TOAST_VISIBLE_MS + 250);
    }

    previousUiStateRef.current = uiState;
    previousDisconnectedAtRef.current = status.disconnectedAt;
  }, [nowMs, stallExplanation, status]);

  useEffect(() => {
    return () => {
      if (deliveryToastIdRef.current) toastManager.close(deliveryToastIdRef.current);
      if (toastResetTimerRef.current !== null) {
        window.clearTimeout(toastResetTimerRef.current);
      }
    };
  }, []);

  return null;
}
