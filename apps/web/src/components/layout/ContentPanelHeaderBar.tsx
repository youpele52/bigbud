import type { ReactNode } from "react";

import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";
import { useSidebar } from "../ui/sidebar";

interface ContentPanelHeaderBarProps {
  readonly actions?: ReactNode;
  readonly title: ReactNode;
}

export function ContentPanelHeaderBar({ actions, title }: ContentPanelHeaderBarProps) {
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
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden sm:gap-3">
        {title}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
