import { type ReactNode } from "react";
import type { useSortable } from "@dnd-kit/sortable";
import { SidebarProjectChevron } from "./SidebarProjectChevron";

export interface SidebarTopLevelHeaderProps {
  onContextMenu?: React.MouseEventHandler<HTMLElement>;
  dragHandleProps?: Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;
}

interface SidebarSectionLabelProps extends SidebarTopLevelHeaderProps {
  actions?: ReactNode;
  children: ReactNode;
  isExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export const sidebarSectionLabelContainerClassName =
  "sticky top-0 z-10 isolate -mx-2 flex h-7 items-center bg-transparent px-4 backdrop-blur-[56px]";
export const sidebarSectionLabelRowClassName = "flex w-full items-center justify-between";
export const sidebarSectionLabelTextClassName = "text-xs font-medium text-foreground/90";
export const sidebarSectionLabelActionsClassName = "flex items-center gap-1";

/**
 * Sticky outer section label used inside the shared sidebar scroll region.
 * Only the high-level section chrome should pin; nested content rows stay in normal flow.
 */
export function SidebarSectionLabel({
  actions,
  children,
  isExpanded,
  onExpandedChange,
  onContextMenu,
  dragHandleProps,
}: SidebarSectionLabelProps) {
  const isCollapsible = onExpandedChange !== undefined && isExpanded !== undefined;

  return (
    <div className={sidebarSectionLabelContainerClassName} onContextMenu={onContextMenu}>
      <div className={sidebarSectionLabelRowClassName}>
        {isCollapsible ? (
          <button
            type="button"
            aria-expanded={isExpanded}
            className="group/project-header inline-flex min-w-0 items-center gap-1.5 rounded-md text-left hover:text-foreground"
            onClick={() => onExpandedChange(!isExpanded)}
            {...dragHandleProps?.attributes}
            {...dragHandleProps?.listeners}
          >
            <span className={sidebarSectionLabelTextClassName}>{children}</span>
            <SidebarProjectChevron expanded={isExpanded} />
          </button>
        ) : (
          <span className={sidebarSectionLabelTextClassName}>{children}</span>
        )}
        {actions ? <div className={sidebarSectionLabelActionsClassName}>{actions}</div> : null}
      </div>
    </div>
  );
}
