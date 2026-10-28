"use client";

import { Toast } from "@base-ui/react/toast";
import { createContext, useContext, type CSSProperties } from "react";
import { useParams } from "@tanstack/react-router";
import { ThreadId } from "@bigbud/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { ToastCloseButton, ToastTitleAndDescription } from "./toast.presentation";
import { ToastVisibleAutoDismiss, usePruneThreadToastTimeouts } from "./toast.autoDismiss";
import { useToastViewportFocus } from "./toast.focus";

import { cn } from "~/lib/utils";
import { buttonVariants } from "~/components/ui/button";
import { buildVisibleToastLayout, shouldHideCollapsedToastContent } from "./toast.logic";
import { toastManager, anchoredToastManager, type ThreadToastData } from "./toast.manager";
export type { ThreadToastData } from "./toast.manager";

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function shouldRenderForActiveThread(
  data: ThreadToastData | undefined,
  activeThreadId: ThreadId | null,
): boolean {
  const toastThreadId = data?.threadId;
  if (!toastThreadId) return true;
  if (data?.hideOnActiveThread) {
    return toastThreadId !== activeThreadId;
  }
  return toastThreadId === activeThreadId;
}

function useActiveThreadIdFromRoute(): ThreadId | null {
  return useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
}

const SharedToastContext = createContext(false);

function ToastProvider({
  children,
  position = "top-right",
  limit = 3,
  ...props
}: ToastProviderProps) {
  return (
    <SharedToastContext value={true}>
      <Toast.Provider toastManager={toastManager} limit={Infinity} {...props}>
        {children}
        <Toasts position={position} limit={limit} />
      </Toast.Provider>
    </SharedToastContext>
  );
}

function Toasts({ position, limit }: { position: ToastPosition; limit: number }) {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadId = useActiveThreadIdFromRoute();
  const isTop = position.startsWith("top");
  // Apply the display limit AFTER thread filtering. Hidden-thread notifications
  // must not consume slots or make the only active-thread card inert.
  let activeIndex = 0;
  const visibleToasts = toasts
    .filter((toast) => shouldRenderForActiveThread(toast.data, activeThreadId))
    .map((toast) => {
      const limited = toast.transitionStatus !== "ending" && activeIndex++ >= limit;
      // Do not mutate Base UI's store objects; also normalize legacy anchors,
      // since Base UI disables swiping whenever positionerProps.anchor exists.
      return Object.assign({}, toast, { limited, positionerProps: undefined });
    });
  const visibleToastLayout = buildVisibleToastLayout(visibleToasts);
  const hasVisibleToasts = visibleToasts.some(
    (toast) => !toast.limited && toast.transitionStatus !== "ending",
  );
  const viewportFocus = useToastViewportFocus(hasVisibleToasts);

  usePruneThreadToastTimeouts(toasts);

  return (
    // Include Base UI's viewport-adjacent focus guards in keyboard exclusion.
    <Toast.Portal data-slot="toast-portal" inert={!hasVisibleToasts}>
      <Toast.Viewport
        {...viewportFocus}
        className={cn(
          "fixed z-50 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-header-offset:52px] [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          // Vertical positioning
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--toast-header-offset))]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          // Horizontal positioning
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
          } as CSSProperties
        }
      >
        {/* Hidden-thread cards still need a root to complete dismissal/removal.
            Without this, close-all leaves unmounted ending entries in the store. */}
        {toasts
          .filter(
            (toast) =>
              toast.transitionStatus === "ending" &&
              !shouldRenderForActiveThread(toast.data, activeThreadId),
          )
          .map((toast) => (
            <Toast.Root key={toast.id} toast={toast} hidden className="hidden" />
          ))}
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );
          const actionProps = toast.actionProps;
          const showErrorCopyButton =
            toast.type === "error" &&
            typeof toast.description === "string" &&
            !toast.data?.hideCopyButton;

          return (
            <Toast.Root
              className={cn(
                "absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) w-full select-none rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                "min-h-(--toast-min-height) max-h-(--toast-max-height) [--toast-min-height:--spacing(12)] [--toast-max-height:--spacing(30)]",
                // Severity remains visible even for notifications without an icon.
                "border-l-2 data-[type=loading]:border-l-info data-[type=info]:border-l-info data-[type=success]:border-l-success data-[type=warning]:border-l-warning data-[type=error]:border-l-destructive",
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // Define some variables
                // Base UI exposes a shared front-most height for the collapsed stack.
                // If that shared measurement is briefly stale, long content can render
                // outside the card until hover expands the toast and swaps to its own height.
                "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))] [--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Limited state
                "data-limited:opacity-0",
                // Expanded state
                "data-expanded:h-(--toast-height)",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:pointer-events-none data-ending-style:opacity-0",
                // Progress can finish before its entrance settles. A cancelled exit
                // transition can strand Base UI's removal waiter, retaining stale status.
                toast.type === "loading" && "data-ending-style:transition-none",
                // Ending animations (direction-aware)
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              data-slot="toast-popup"
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <ToastVisibleAutoDismiss
                dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                toastId={toast.id}
              />
              <Toast.Content
                className={cn(
                  "pointer-events-auto min-h-[calc(var(--toast-min-height)-2px)] max-h-[calc(var(--toast-max-height)-2px)] overflow-hidden px-3.5 py-3 text-sm transition-opacity duration-250 data-expanded:opacity-100 relative flex flex-col gap-2",
                  hideCollapsedContent &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                <ToastCloseButton
                  className="absolute top-3 right-3"
                  exposeToAccessibility={visibleIndex === 0}
                />
                <ToastTitleAndDescription
                  Icon={Icon}
                  icon={toast.data?.icon}
                  description={showErrorCopyButton ? toast.description : null}
                  hideCopyButton={!showErrorCopyButton}
                />
                {actionProps && (
                  <div className="flex shrink-0 items-center justify-end gap-2">
                    <Toast.Action
                      className={cn(buttonVariants({ size: "xs" }), "shrink-0")}
                      data-slot="toast-action"
                    >
                      {actionProps.children}
                    </Toast.Action>
                  </div>
                )}
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

// Backward compatible wrapper, including standalone use. A nested wrapper must
// not subscribe twice to the same manager or render a second overlapping stack.
function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  const hasSharedProvider = useContext(SharedToastContext);
  if (hasSharedProvider) return children;
  return <ToastProvider {...props}>{children}</ToastProvider>;
}

export {
  ToastProvider,
  type ToastPosition,
  toastManager,
  AnchoredToastProvider,
  anchoredToastManager,
};
