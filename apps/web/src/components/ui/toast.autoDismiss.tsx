import { useEffect } from "react";
import { dismissToast, toastManager } from "./toast.manager";

type ToastId = ReturnType<typeof toastManager.add>;
// Remaining visible time per toast and phase; a progress toast that turns into
// its outcome (another `phase`) starts a fresh countdown.
const threadToastVisibleTimeoutRemainingMs = new Map<
  ToastId,
  { phase: string; remainingMs: number }
>();

export function ToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
  phase = "",
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
  phase?: string | undefined;
}) {
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const saved = threadToastVisibleTimeoutRemainingMs.get(toastId);
    let remainingMs = saved?.phase === phase ? saved.remainingMs : dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;

    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };

    const closeToast = () => {
      if (closed) return;
      closed = true;
      threadToastVisibleTimeoutRemainingMs.delete(toastId);
      // Auto-dismissal counts as a dismissal for the shared toast policy.
      dismissToast(toastId);
    };

    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      threadToastVisibleTimeoutRemainingMs.set(toastId, { phase, remainingMs });
    };

    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };

    // Like Base UI's store timers, pause while the stack is hovered or focused.
    const viewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]');
    let hovering = viewport?.matches(":hover") ?? false;
    let focused = viewport?.contains(document.activeElement) ?? false;

    const syncTimer = () => {
      const shouldRun =
        document.visibilityState === "visible" && document.hasFocus() && !hovering && !focused;
      if (shouldRun) {
        start();
        return;
      }
      pause();
    };
    const leaves = (event: Event, related: EventTarget | null) =>
      !(related instanceof Node && (event.currentTarget as HTMLElement).contains(related));
    const onMouseOver = () => {
      hovering = true;
      syncTimer();
    };
    const onMouseOut = (event: MouseEvent) => {
      if (leaves(event, event.relatedTarget)) hovering = false;
      syncTimer();
    };
    const onFocusIn = () => {
      focused = true;
      syncTimer();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (leaves(event, event.relatedTarget)) focused = false;
      syncTimer();
    };

    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    window.addEventListener("focus", syncTimer);
    window.addEventListener("blur", syncTimer);
    viewport?.addEventListener("mouseover", onMouseOver);
    viewport?.addEventListener("mouseout", onMouseOut);
    viewport?.addEventListener("focusin", onFocusIn);
    viewport?.addEventListener("focusout", onFocusOut);

    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      window.removeEventListener("focus", syncTimer);
      window.removeEventListener("blur", syncTimer);
      viewport?.removeEventListener("mouseover", onMouseOver);
      viewport?.removeEventListener("mouseout", onMouseOut);
      viewport?.removeEventListener("focusin", onFocusIn);
      viewport?.removeEventListener("focusout", onFocusOut);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, phase, toastId]);

  return null;
}

export function usePruneThreadToastTimeouts(toasts: readonly { id: ToastId }[]) {
  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    for (const toastId of threadToastVisibleTimeoutRemainingMs.keys()) {
      if (!activeToastIds.has(toastId)) {
        threadToastVisibleTimeoutRemainingMs.delete(toastId);
      }
    }
  }, [toasts]);
}
