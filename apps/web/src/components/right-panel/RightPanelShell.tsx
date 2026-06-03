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
        className="hidden shrink-0 bg-transparent md:block"
        data-right-panel-placeholder="true"
        style={{ width: open ? width : 0 }}
      />
      <div
        className={cn(
          "fixed right-0 top-0 z-40 flex h-dvh flex-col border-l border-border bg-card text-foreground",
          className,
        )}
        style={{ width, right: open ? 0 : -width }}
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
