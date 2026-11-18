import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { MobileRpcClient } from "./mobileRpc";
import { isMobileSessionExpired, type StoredMobileSession } from "./mobileSession";
import {
  canRestartMobileConnection,
  installMobileResumeListeners,
  resolveMobileResumeAction,
} from "../logic/mobileConnection.resume";
import {
  createMobileConnectionLifecycle,
  scheduleMobileConnectionExpiry,
  type MobileConnectionLifecycle,
  type MobileConnectionState,
} from "../logic/mobileConnection.logic";

interface MobileConnectionOptions {
  readonly beforeConnect?: (signal: AbortSignal) => Promise<void>;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
  /** A visible resume found the socket still open. */
  readonly onResumeOpen?: () => void;
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
  const sessionIdentityRef = useRef<string | null>(null);
  const clientRef = useRef<MobileRpcClient | null>(null);
  const onOpenRef = useRef(options?.onOpen);
  const onCloseRef = useRef(options?.onClose);
  onOpenRef.current = options?.onOpen;
  onCloseRef.current = options?.onClose;
  const beforeConnect = options?.beforeConnect;
  const onResumeOpenRef = useRef(options?.onResumeOpen);
  onResumeOpenRef.current = options?.onResumeOpen;

  const connection = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getState,
    lifecycle.getState,
  );

  const restart = useCallback(() => {
    if (!canRestartMobileConnection(lifecycle.getState())) return;
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

    const identity = JSON.stringify([
      session.backendBaseUrl,
      session.sessionId,
      session.sessionToken,
    ]);
    if (sessionIdentityRef.current !== identity) lifecycle.reset();
    sessionIdentityRef.current = identity;
    if (!canRestartMobileConnection(lifecycle.getState())) return;
    const lease = lifecycle.begin(session.expiresAt);
    restartPendingRef.current = false;
    if (isMobileSessionExpired(session)) {
      lease.expire();
      return () => lease.dispose();
    }

    let disposed = false;
    const nextClient = new MobileRpcClient(wsUrl, {
      ...lease.handlers,
      ...(beforeConnect ? { beforeConnect } : {}),
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
    const onResume = () => {
      lifecycle.setBrowserOffline(typeof navigator !== "undefined" && navigator.onLine === false);
      const action = resolveMobileResumeAction({
        visible: document.visibilityState !== "hidden",
        sessionExpired: isMobileSessionExpired(session),
        transport: lifecycle.getState().transport,
        authorization: lifecycle.getState().authorization,
      });
      if (action === "expire") expire();
      else if (action === "restart") restart();
      else if (
        document.visibilityState !== "hidden" &&
        lifecycle.getState().transport === "open" &&
        lease.isActive()
      ) {
        onResumeOpenRef.current?.();
      }
    };
    const removeResumeListeners = installMobileResumeListeners(
      { window, document },
      {
        onOnline: () => {
          lifecycle.setBrowserOffline(false);
          onResume();
        },
        onOffline: () => lifecycle.setBrowserOffline(true),
        onResume,
      },
    );

    return () => {
      disposed = true;
      cancelExpiry();
      removeResumeListeners();
      lease.dispose();
      if (clientRef.current === nextClient) clientRef.current = null;
      setClient((current) => (current === nextClient ? null : current));
      void nextClient.dispose();
    };
  }, [beforeConnect, lifecycle, restart, restartVersion, session, wsUrl]);

  return {
    client,
    connection: connection as MobileConnectionState,
    restart,
  };
}
