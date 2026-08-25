import { ChevronRightIcon } from "lucide-react";
import { SIDEBAR_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";

interface SidebarProjectChevronProps {
  expanded: boolean;
}

export function SidebarProjectChevron({ expanded }: SidebarProjectChevronProps) {
  return (
    <ChevronRightIcon
      className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70 transition-all duration-150 ${
        expanded
          ? "rotate-90"
          : "translate-x-1 opacity-0 group-hover/project-header:translate-x-0 group-hover/project-header:opacity-100"
      }`}
    />
  );
}
