import { useEffect, useEffectEvent } from "react";

import { subscribeDesktopConnectivitySignals } from "../rpc/desktopConnectivitySignals";
import type { WsAutoReconnectTrigger } from "./WebSocketConnectionSurface.logic";

interface WebSocketReconnectTriggerHandlers {
  readonly onTrigger: (trigger: WsAutoReconnectTrigger) => void;
  /** `browser` re-reads `navigator.onLine`; `desktop` is Electron main reporting offline. */
  readonly onOffline: (source: "browser" | "desktop") => void;
  /**
   * Suspend or resume: in-flight heartbeat probes must not count as failures. Both edges reset,
   * because Windows timers count sleep time and a probe can time out the moment the machine wakes.
   */
  readonly onSleepBoundary: () => void;
}

/** Browser focus, visibility and network events plus Electron power and network hints. */
export function useWebSocketReconnectTriggers(handlers: WebSocketReconnectTriggerHandlers) {
  const trigger = useEffectEvent((kind: WsAutoReconnectTrigger) => handlers.onTrigger(kind));
  const offline = useEffectEvent((source: "browser" | "desktop") => handlers.onOffline(source));
  const sleepBoundary = useEffectEvent(() => handlers.onSleepBoundary());

  useEffect(() => {
    const handleOnline = () => trigger("online");
    const handleFocus = () => trigger("focus");
    const handleOffline = () => offline("browser");
    const handleVisibility = () => {
      if (document.visibilityState === "visible") trigger("visible");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    const unsubscribeDesktop = subscribeDesktopConnectivitySignals(
      window.desktopBridge,
      (signal) => {
        switch (signal.kind) {
          case "resume":
            // Reset first so the wake probe starts fresh rather than joining a stale one.
            sleepBoundary();
            trigger("resume");
            return;
          case "unlock-screen":
            trigger("unlock");
            return;
          case "online":
            trigger("online");
            return;
          case "offline":
            offline("desktop");
            return;
          case "suspend":
            sleepBoundary();
            return;
          case "lock-screen":
            return;
        }
      },
    );
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
      unsubscribeDesktop();
    };
  }, []);
}
