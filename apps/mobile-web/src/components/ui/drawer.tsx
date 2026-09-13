import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import type * as React from "react";

import { cn } from "../../lib/cn";

const Drawer = DrawerPrimitive.Root;
const DrawerPortal = DrawerPrimitive.Portal;

function DrawerBackdrop({ className, ...props }: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/32 backdrop-blur-sm transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
        className,
      )}
      data-slot="drawer-backdrop"
      {...props}
    />
  );
}

function DrawerViewport({ className, ...props }: DrawerPrimitive.Viewport.Props) {
  return (
    <DrawerPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 flex items-end justify-center px-2 pt-[calc(2rem+env(safe-area-inset-top))]",
        className,
      )}
      data-slot="drawer-viewport"
      {...props}
    />
  );
}

function DrawerPopup({ className, ...props }: DrawerPrimitive.Popup.Props) {
  return (
    <DrawerPrimitive.Popup
      className={cn(
        "mobile-drawer-popup relative flex h-[min(42rem,calc(100dvh-2rem-env(safe-area-inset-top)))] max-h-[calc(100dvh-2rem-env(safe-area-inset-top))] min-h-0 w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-border bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-2xl outline-none transition-[translate,opacity] duration-[280ms] ease-out will-change-[translate,opacity] data-ending-style:duration-[220ms] data-ending-style:ease-in data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
        className,
      )}
      data-slot="drawer-popup"
      {...props}
    />
  );
}

function DrawerContent({ className, ...props }: DrawerPrimitive.Content.Props) {
  return (
    <DrawerPrimitive.Content
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", className)}
      data-base-ui-swipe-ignore=""
      data-slot="drawer-content"
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      className={cn("text-sm font-semibold", className)}
      data-slot="drawer-title"
      {...props}
    />
  );
}

function DrawerDescription({ className, ...props }: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      data-slot="drawer-description"
      {...props}
    />
  );
}

function DrawerClose({ className, ...props }: DrawerPrimitive.Close.Props) {
  return (
    <DrawerPrimitive.Close
      className={cn("inline-flex items-center justify-center text-sm", className)}
      data-slot="drawer-close"
      {...props}
    />
  );
}

function DrawerHandle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex h-11 w-20 shrink-0 items-start justify-center pt-2", className)}
      data-slot="drawer-handle"
      {...props}
    >
      <span className="h-1 w-10 rounded-full bg-muted-foreground/35" />
    </div>
  );
}

export {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHandle,
  DrawerPopup,
  DrawerPortal,
  DrawerTitle,
  DrawerViewport,
};
