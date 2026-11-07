import { useSyncExternalStore } from "react";
import { subscribeDesktopConnectivitySignals } from "../rpc/desktopConnectivitySignals";

const snapshot = () => new Date().setHours(0, 0, 0, 0);

/** One local-midnight timer for all mounted timestamp labels, not one per message. */
export function createLocalDayStore() {
  const listeners = new Set<() => void>();
  let day = snapshot();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopLifecycle: (() => void) | undefined;

  const refresh = () => {
    if (timer !== undefined) clearTimeout(timer);
    const next = snapshot();
    if (next !== day) {
      day = next;
      listeners.forEach((listener) => listener());
    }
    if (listeners.size === 0) return;
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    timer = setTimeout(refresh, midnight.getTime() - now.getTime());
  };

  return {
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        window.addEventListener("focus", refresh);
        window.addEventListener("pageshow", refresh);
        const visible = () => {
          if (document.visibilityState === "visible") refresh();
        };
        document.addEventListener("visibilitychange", visible);
        const unsubscribeDesktop = subscribeDesktopConnectivitySignals(
          window.desktopBridge,
          (signal) => {
            if (signal.kind === "resume" || signal.kind === "unlock-screen") refresh();
          },
        );
        stopLifecycle = () => {
          window.removeEventListener("focus", refresh);
          window.removeEventListener("pageshow", refresh);
          document.removeEventListener("visibilitychange", visible);
          unsubscribeDesktop();
        };
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size !== 0) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        stopLifecycle?.();
        stopLifecycle = undefined;
      };
    },
  };
}

const localDayStore = createLocalDayStore();

/** Subscribe in timestamp leaves so calendar changes do not rerender chat bodies. */
export function useLocalDay() {
  return useSyncExternalStore(
    localDayStore.subscribe,
    localDayStore.snapshot,
    localDayStore.snapshot,
  );
}
