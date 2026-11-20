import type { ReactNode } from "react";

import { BigbudLogo } from "./sidebar/SidebarProjectItem";

/**
 * Shared right-panel empty state: the muted bigbud mark centred, with a short note right under it.
 * Used by the Git and Diff panels so their quiet states look the same.
 */
export function PanelEmptyState(props: { readonly children: ReactNode; readonly testId?: string }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-5 text-center"
      data-testid={props.testId}
    >
      <BigbudLogo decorative className="h-7 text-muted-foreground/50" />
      <p className="text-xs text-muted-foreground/70">{props.children}</p>
    </div>
  );
}
