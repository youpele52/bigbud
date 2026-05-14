import { type ReactNode } from "react";

interface SidebarSectionLabelProps {
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Sticky outer section label used inside the shared sidebar scroll region.
 * Only the high-level section chrome should pin; nested content rows stay in normal flow.
 */
export function SidebarSectionLabel({ actions, children }: SidebarSectionLabelProps) {
  return (
    <div className="sticky top-0 z-10 isolate -mx-2 bg-card px-4 pt-1.5 pb-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          {children}
        </span>
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  );
}
