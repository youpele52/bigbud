import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { MobileRpcClient } from "./mobileRpc";
import { isMobileSessionExpired, type StoredMobileSession } from "./mobileSession";
import {
  createMobileConnectionLifecycle,
  scheduleMobileConnectionExpiry,
  type MobileConnectionLifecycle,
  type MobileConnectionState,
} from "../logic/mobileConnection.logic";

interface MobileConnectionOptions {
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
}

export function useMobileConnection(
  session: StoredMobileSession | null,
  wsUrl: string | null,
  options?: MobileConnectionOptions,
) {
  const lifecycleRef = useRef<MobileConnectionLifecycle | null>(null);
  if (lifecycleRef.current === null) lifecycleRef.current = createMobileConnectionLifecycle();
  const lifecycle = lifecycleRef.current;
  const [client, setClient] = useState<MobileRpcClient | null>(null);
  const [restartVersion, setRestartVersion] = useState(0);
  const restartPendingRef = useRef(false);
  const clientRef = useRef<MobileRpcClient | null>(null);
  const onOpenRef = useRef(options?.onOpen);
  const onCloseRef = useRef(options?.onClose);
  onOpenRef.current = options?.onOpen;
  onCloseRef.current = options?.onClose;

  const connection = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getState,
    lifecycle.getState,
  );

  const restart = useCallback(() => {
    if (lifecycle.getState().expired) return;
    if (restartPendingRef.current) return;
    restartPendingRef.current = true;
    setRestartVersion((current) => current + 1);
  }, [lifecycle]);

  useEffect(() => {
    const setBrowserOffline = () =>
      lifecycle.setBrowserOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    setBrowserOffline();
    if (!session || !wsUrl) {
      lifecycle.reset();
      setClient(null);
      clientRef.current = null;
      return;
    }

    const lease = lifecycle.begin(session.expiresAt);
    restartPendingRef.current = false;
    if (isMobileSessionExpired(session)) {
      lease.expire();
      return () => lease.dispose();
    }

    let disposed = false;
    const nextClient = new MobileRpcClient(wsUrl, {
      ...lease.handlers,
      onOpen: () => {
        lease.handlers.onOpen?.();
        if (lease.isActive()) onOpenRef.current?.();
      },
      onClose: (details) => {
        lease.handlers.onClose?.(details);
        if (lease.isActive()) onCloseRef.current?.();
      },
    });
    clientRef.current = nextClient;
    setClient(nextClient);

    const expire = () => {
      if (disposed) return;
      lease.expire();
      if (clientRef.current === nextClient) {
        clientRef.current = null;
        setClient(null);
      }
      void nextClient.dispose();
    };
    const cancelExpiry = scheduleMobileConnectionExpiry({
      expiresAt: session.expiresAt,
      onExpired: expire,
    });
    const onOnline = () => {
      lifecycle.setBrowserOffline(false);
      onResume();
    };
    const onOffline = () => lifecycle.setBrowserOffline(true);
    const onResume = () => {
      lifecycle.setBrowserOffline(typeof navigator !== "undefined" && navigator.onLine === false);
      if (isMobileSessionExpired(session)) {
        expire();
        return;
      }
      const transport = lifecycle.getState().transport;
      if (transport === "closed" || transport === "exhausted") restart();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);

    return () => {
      disposed = true;
      cancelExpiry();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
      lease.dispose();
      if (clientRef.current === nextClient) clientRef.current = null;
      setClient((current) => (current === nextClient ? null : current));
      void nextClient.dispose();
    };
  }, [lifecycle, restart, restartVersion, session, wsUrl]);

  return {
    client,
    connection: connection as MobileConnectionState,
    restart,
  };
}
