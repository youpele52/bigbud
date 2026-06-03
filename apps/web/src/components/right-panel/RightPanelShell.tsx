import type * as React from "react";

import { cn } from "~/lib/utils";

interface RightPanelShellProps {
  className?: string | undefined;
  children: React.ReactNode;
  open: boolean;
  resizeAriaLabel?: string | undefined;
  width: number;
  onResizePointerDown?: ((event: React.PointerEvent<HTMLDivElement>) => void) | undefined;
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
          "fixed right-0 top-0 z-40 flex h-dvh flex-col border-l border-border bg-card text-foreground transition-[transform,width] duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
          className,
        )}
        style={{ width, transform: open ? "translateX(0)" : "translateX(100%)" }}
      >
        {children}
        {onResizePointerDown ? (
          <div
            className="absolute inset-y-0 left-0 z-50 hidden w-4 cursor-col-resize md:block"
            onPointerDown={onResizePointerDown}
            role="button"
            aria-label={resizeAriaLabel}
            tabIndex={0}
          >
            <div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-transparent hover:bg-border" />
          </div>
        ) : null}
      </div>
    </>
  );
}
