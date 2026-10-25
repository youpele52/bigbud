import { useEffect, useEffectEvent, type RefObject } from "react";
import {
  createHistorySwipeRecognizer,
  historySwipeWheelRejection,
} from "@bigbud/shared/historySwipe";

import { isElectron } from "../../config/env";

/** A gap with no wheel input separates gestures; momentum never leaves one, so it cannot re-arm. */
export const FILES_SWIPE_QUIET_PERIOD_MS = 250;
export const FILES_SWIPE_COOLDOWN_MS = 1200;

/**
 * Two-finger horizontal swipes step through file history in the desktop app on every OS
 * with a precise touchpad. Previews that can still scroll sideways keep the gesture, as in
 * the in-app browser. Off in a regular browser tab, which owns that gesture for its own
 * back/forward.
 */
export function useFilesPanelSwipeNavigation(
  panelRef: RefObject<HTMLElement | null>,
  canNavigate: (direction: -1 | 1) => boolean,
  navigate: (direction: -1 | 1) => void,
  enabled = isElectron,
) {
  const commit = useEffectEvent((direction: -1 | 1) => {
    if (canNavigate(direction)) navigate(direction);
  });

  // Gesture state must survive history changes: re-subscribing mid-swipe would let the
  // remaining momentum start a second navigation.
  useEffect(() => {
    const panel = panelRef.current;
    if (!enabled || !panel) return;
    const recognizer = createHistorySwipeRecognizer();
    let lastWheel = -Infinity;
    let cooldownUntil = 0;
    const handleWheel = (event: WheelEvent) => {
      const time = performance.now();
      const first = time - lastWheel >= FILES_SWIPE_QUIET_PERIOD_MS;
      lastWheel = time;
      if (first) {
        if (time < cooldownUntil || panel.closest("[inert]")) recognizer.cancel();
        else recognizer.begin();
      }
      if (!recognizer.isActive()) return;
      const path = event.composedPath();
      // Inspect after propagation so a preview's own preventDefault wins.
      queueMicrotask(() => {
        const direction = recognizer.push({
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          time,
          blocked: historySwipeWheelRejection(event, path, panel) !== null,
        });
        if (!direction) return;
        cooldownUntil = time + FILES_SWIPE_COOLDOWN_MS;
        commit(direction === "back" ? -1 : 1);
      });
    };
    panel.addEventListener("wheel", handleWheel, { passive: true });
    return () => panel.removeEventListener("wheel", handleWheel);
  }, [enabled, panelRef]);
}
