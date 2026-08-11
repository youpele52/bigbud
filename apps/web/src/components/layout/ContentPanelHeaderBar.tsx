import type { ReactNode } from "react";

import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";
import { useSidebar } from "../ui/sidebar";

interface ContentPanelHeaderBarProps {
  readonly actions?: ReactNode;
  readonly center?: ReactNode;
  readonly title: ReactNode;
}

export const CONTENT_PANEL_HEADER_CENTER_GRID_CLASS =
  "grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2";

export function ContentPanelHeaderBar({ actions, center, title }: ContentPanelHeaderBarProps) {
  const { open: sidebarOpen } = useSidebar();

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      {!sidebarOpen && (
        <div
          className={cn(
            "hidden shrink-0 md:block",
            isElectron ? "w-20" : "h-0 w-[calc(3rem+1rem)]",
          )}
        />
      )}
      {center ? (
        <div className={CONTENT_PANEL_HEADER_CENTER_GRID_CLASS}>
          <div className="flex min-w-0 items-center overflow-hidden">{title}</div>
          <div className="min-w-0">{center}</div>
          <div className="flex min-w-0 justify-end">{actions}</div>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden sm:gap-3">
            {title}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center justify-end gap-2">{actions}</div>
          ) : null}
        </>
      )}
    </div>
  );
}
