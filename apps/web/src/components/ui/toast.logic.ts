export function shouldHideCollapsedToastContent(
  visibleToastIndex: number,
  visibleToastCount: number,
): boolean {
  // Keep the front-most toast readable even if Base UI marks it as "behind"
  // due to toasts hidden by thread filtering.
  if (visibleToastCount <= 1) return false;
  return visibleToastIndex > 0;
}

type ToastWithHeight = {
  height?: number | null | undefined;
  transitionStatus?: string | undefined;
  limited?: boolean | undefined;
};

type VisibleToastLayoutItem<TToast extends object> = {
  toast: TToast;
  visibleIndex: number;
  offsetY: number;
};

export function buildVisibleToastLayout<TToast extends object>(
  visibleToasts: readonly (TToast & ToastWithHeight)[],
): {
  frontmostHeight: number;
  items: VisibleToastLayoutItem<TToast & ToastWithHeight>[];
} {
  let offsetY = 0;
  let visibleIndex = 0;
  return {
    frontmostHeight: normalizeToastHeight(visibleToasts.find(occupiesSlot)?.height),
    items: visibleToasts.map((toast) => {
      const item = {
        toast,
        visibleIndex,
        offsetY,
      };

      // Retain exiting/limited roots for Base UI lifecycle and queue handling,
      // but never reserve space for them in the visible stack.
      if (occupiesSlot(toast)) {
        offsetY += normalizeToastHeight(toast.height);
        visibleIndex += 1;
      }
      return item;
    }),
  };
}

function occupiesSlot(toast: ToastWithHeight): boolean {
  return toast.transitionStatus !== "ending" && !toast.limited;
}

function normalizeToastHeight(height: number | null | undefined): number {
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
}
