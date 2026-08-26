import { useEffect, useRef, useState } from "react";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";

import { isElectron } from "../config/env";
import { getWsConnectionStatus } from "../rpc/wsConnectionState";
import { getWsRpcClient } from "../rpc/wsRpcClient";
import {
  shouldContinueDesktopStartupReconnect,
  shouldReconnectAfterDesktopStartupTransition,
} from "./WebSocketConnectionSurface.logic";
import { toastManager } from "./ui/toast";

const NOTICE_DELAY_MS = 30_000;
const RECONNECT_INTERVAL_MS = 1_000;

export async function getInitialDesktopBackendStartupState(
  getState: () => Promise<DesktopBackendStartupState>,
): Promise<DesktopBackendStartupState | null> {
  try {
    return await getState();
  } catch {
    return null;
  }
}

export function useDesktopBackendStartupState(): DesktopBackendStartupState | null {
  const [state, setState] = useState<DesktopBackendStartupState | null>(null);
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!isElectron || !bridge?.getBackendStartupState || !bridge.onBackendStartupState) return;
    let disposed = false;
    let receivedUpdate = false;
    const unsubscribe = bridge.onBackendStartupState((next) => {
      if (!disposed) {
        receivedUpdate = true;
        setState(next);
      }
    });
    void getInitialDesktopBackendStartupState(bridge.getBackendStartupState).then((next) => {
      if (!disposed && !receivedUpdate && next) setState(next);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return state;
}

export function DesktopBackendStartupCoordinator() {
  const state = useDesktopBackendStartupState();
  const toastRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const toastGenerationRef = useRef<number | null>(null);
  const previousStateRef = useRef<DesktopBackendStartupState | null>(null);

  useEffect(() => {
    if (!state || (state.status !== "starting" && state.status !== "upgrading")) return;
    if (toastGenerationRef.current !== state.generation && toastRef.current) {
      toastManager.close(toastRef.current);
      toastRef.current = null;
    }
    toastGenerationRef.current = state.generation;
    const toast = {
      description:
        state.status === "upgrading"
          ? "Updating local data. Please wait."
          : "bigbud is still starting. Please wait.",
      timeout: 0,
      title: "Starting bigbud",
      type: "info" as const,
      data: { hideCopyButton: true },
    };
    if (toastRef.current) {
      toastManager.update(toastRef.current, toast);
      return;
    }
    const remaining = Math.max(0, state.startedAt + NOTICE_DELAY_MS - Date.now());
    const show = () => {
      if (toastGenerationRef.current === state.generation && !toastRef.current) {
        toastRef.current = toastManager.add(toast);
      }
    };
    const timer = window.setTimeout(show, remaining);
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (state?.status === "starting" || state?.status === "upgrading") return;
    if (toastRef.current) toastManager.close(toastRef.current);
    toastRef.current = null;
    toastGenerationRef.current = null;
  }, [state?.generation, state?.status]);

  useEffect(() => {
    const previousState = previousStateRef.current;
    previousStateRef.current = state;
    if (shouldReconnectAfterDesktopStartupTransition(isElectron, previousState, state)) {
      void getWsRpcClient().reconnect();
    }
  }, [state]);

  useEffect(() => {
    if (!shouldContinueDesktopStartupReconnect(state)) return;
    const interval = window.setInterval(() => {
      if (getWsConnectionStatus().reconnectPhase === "exhausted") void getWsRpcClient().reconnect();
    }, RECONNECT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [state]);

  useEffect(
    () => () => {
      if (toastRef.current) toastManager.close(toastRef.current);
      toastGenerationRef.current = null;
    },
    [],
  );
  return null;
}
