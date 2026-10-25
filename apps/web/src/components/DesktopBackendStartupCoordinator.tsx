import { useEffect, useRef, useState } from "react";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";

import { isElectron } from "../config/env";
import { getWsRpcClient } from "../rpc/wsRpcClient";
import { resolveDesktopStartupReconnect } from "./WebSocketConnectionSurface.logic";
import { toastManager } from "./ui/toast";

const NOTICE_DELAY_MS = 30_000;

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

/** Toast text while the backend starts; shows migration progress when the backend reports it. */
export function describeDesktopStartupProgress(state: DesktopBackendStartupState): string {
  if (state.status !== "upgrading") return "bigbud is still starting. Please wait.";
  const percent = state.progressPercent === undefined ? "" : `, ${state.progressPercent}%`;
  return `Updating local data${percent}. Please wait.`;
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
      description: describeDesktopStartupProgress(state),
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
    const reconnect = resolveDesktopStartupReconnect(isElectron, previousState, state);
    if (reconnect === "replace-session") void getWsRpcClient().reconnect();
    // A backend that just became (or is confirmed) ready: skip the current backoff wait.
    else if (reconnect === "skip-backoff") getWsRpcClient().reconnectNow();
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
