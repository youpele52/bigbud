import { type ReactNode } from "react";

interface SidebarSectionLabelProps {
  actions?: ReactNode;
  children: ReactNode;
}

export const sidebarSectionLabelContainerClassName =
  "sticky top-0 z-10 isolate -mx-2 bg-transparent px-4 pt-1.5 pb-2 backdrop-blur-[56px]";
export const sidebarSectionLabelRowClassName = "flex items-center justify-between";
export const sidebarSectionLabelTextClassName = "text-xs font-medium text-foreground/90";
export const sidebarSectionLabelActionsClassName = "flex items-center gap-1";

/**
 * Sticky outer section label used inside the shared sidebar scroll region.
 * Only the high-level section chrome should pin; nested content rows stay in normal flow.
 */
export function SidebarSectionLabel({ actions, children }: SidebarSectionLabelProps) {
  return (
    <div className={sidebarSectionLabelContainerClassName}>
      <div className={sidebarSectionLabelRowClassName}>
        <span className={sidebarSectionLabelTextClassName}>{children}</span>
        {actions ? <div className={sidebarSectionLabelActionsClassName}>{actions}</div> : null}
      </div>
    </div>
  );
}
