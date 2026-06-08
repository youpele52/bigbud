import type { ReactNode } from "react";
import { useCallback, useRef } from "react";

import { useGitPanelSidebarWidth } from "./useGitPanelSidebarWidth";

interface GitPanelSplitViewProps {
  main: ReactNode;
  resizeAriaLabel: string;
  sidebar: ReactNode;
}

export function GitPanelSplitView({ main, resizeAriaLabel, sidebar }: GitPanelSplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { sidebarWidth, resizeSidebarWidth } = useGitPanelSidebarWidth();

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;

      const onPointerMove = (moveEvent: PointerEvent) => {
        resizeSidebarWidth(
          container.getBoundingClientRect().width,
          startWidth,
          moveEvent.clientX - startX,
        );
      };
      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [resizeSidebarWidth, sidebarWidth],
  );

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      <div
        className="min-h-0 overflow-auto border-r border-border/60"
        style={{ width: sidebarWidth }}
      >
        {sidebar}
      </div>
      <div
        className="z-10 w-[3px] shrink-0 cursor-col-resize select-none hover:bg-primary/30"
        role="separator"
        aria-label={resizeAriaLabel}
        aria-orientation="vertical"
        onPointerDown={handleResizePointerDown}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{main}</div>
    </div>
  );
}
