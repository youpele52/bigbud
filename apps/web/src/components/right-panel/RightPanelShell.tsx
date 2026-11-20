import type * as React from "react";

import { cn } from "~/lib/utils";
import { RESIZE_HANDLE_CLASS_NAME } from "../ui/sidebar.shared";

interface RightPanelShellProps {
  className?: string | undefined;
  children: React.ReactNode;
  open: boolean;
  resizeAriaLabel?: string | undefined;
  width: number;
  onResizePointerDown?: ((event: React.PointerEvent<HTMLButtonElement>) => void) | undefined;
}

export function RightPanelShell({
  className,
  children,
  open,
  resizeAriaLabel,
  width,
  onResizePointerDown,
}: RightPanelShellProps) {
  return (
    <>
      <div
        className="hidden shrink-0 bg-transparent transition-[width] duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)] md:block"
        data-right-panel-placeholder="true"
        style={{ width: open ? width : 0 }}
      />
      <div
        className={cn(
          "fixed right-0 top-0 z-40 flex h-dvh flex-col border-l border-border bg-[var(--app-shell-side-panel-background)] text-foreground transition-[transform,width] duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
          className,
        )}
        data-app-shell-side-panel="true"
        style={{ width, transform: open ? "translateX(0)" : "translateX(100%)" }}
      >
        {children}
        {onResizePointerDown ? (
          <button
            aria-label={resizeAriaLabel}
            className={cn(
              RESIZE_HANDLE_CLASS_NAME,
              // Anchored to the border edge, like the sidebar rail, so the line covers the border.
              "absolute inset-y-0 -left-px z-50 hidden cursor-e-resize md:block",
            )}
            onPointerDown={onResizePointerDown}
            tabIndex={-1}
            type="button"
          />
        ) : null}
      </div>
    </>
  );
}
