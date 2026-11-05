import { Toast } from "@base-ui/react/toast";
import { useEffect, useRef } from "react";
import type { ThreadToastData } from "./toast.manager";

export const TOAST_DISMISS_ALL_HOLD_MS = 650;
export const TOAST_DISMISS_ALL_HINT =
  "Close notification. Hold to close all notifications, or press Shift+Delete.";

// Keep the snapshot local to the gesture: a toast arriving during a hold (or
// synchronously from an onClose callback) must not be dismissed accidentally.
export function useToastDismissAllGesture() {
  const { toasts, close } = Toast.useToastManager<ThreadToastData>();
  const press = useRef<{
    pointerId: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
    cleanup: () => void;
  } | null>(null);
  const suppressClick = useRef(false);

  function clearPress() {
    if (!press.current) return false;
    clearTimeout(press.current.timer);
    press.current.cleanup();
    press.current = null;
    return true;
  }

  function cancel() {
    if (clearPress()) suppressClick.current = true;
  }

  useEffect(() => cancel, []);

  const handlers: Pick<
    Toast.Close.Props,
    | "onPointerDown"
    | "onPointerMove"
    | "onPointerUp"
    | "onPointerCancel"
    | "onPointerLeave"
    | "onLostPointerCapture"
    | "onBlur"
    | "onClick"
    | "onKeyDown"
    | "onContextMenu"
  > = {
    onPointerDown(event) {
      cancel();
      suppressClick.current = false;
      if (event.button !== 0 || !event.isPrimary) return;
      const ids = toasts.filter((toast) => toast.transitionStatus !== "ending").map(({ id }) => id);
      event.currentTarget.setPointerCapture(event.pointerId);
      // Only an active gesture needs global listeners, not every queued card.
      window.addEventListener("blur", cancel);
      document.addEventListener("visibilitychange", cancel);
      press.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          clearPress();
          suppressClick.current = true;
          ids.forEach((id) => close(id));
        }, TOAST_DISMISS_ALL_HOLD_MS),
        cleanup() {
          window.removeEventListener("blur", cancel);
          document.removeEventListener("visibilitychange", cancel);
        },
      };
    },
    onPointerMove(event) {
      const start = press.current;
      if (!start || event.pointerId !== start.pointerId) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) cancel();
    },
    onPointerUp(event) {
      if (!press.current || event.pointerId !== press.current.pointerId) return;
      clearPress();
    },
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onLostPointerCapture: cancel,
    onBlur: cancel,
    onClick(event) {
      if (suppressClick.current && event.detail !== 0) {
        event.preventDefault();
        event.preventBaseUIHandler();
      }
      // A cancelled pointer gesture must not swallow subsequent keyboard/AT activation.
      suppressClick.current = false;
    },
    onKeyDown(event) {
      if (event.shiftKey && event.key === "Delete") {
        event.preventDefault();
        cancel();
        const ids = toasts
          .filter((toast) => toast.transitionStatus !== "ending")
          .map(({ id }) => id);
        ids.forEach((id) => close(id));
      }
    },
    onContextMenu(event) {
      // Avoid the native touch-hold context menu interrupting the gesture.
      event.preventDefault();
    },
  };
  return handlers;
}
