import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";

import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { useItutuThreadCount } from "./Sidebar.itutu.count";
import { ITUTU_STATE_LABELS } from "./Sidebar.itutu.logic";
import { SidebarSectionLabel } from "./SidebarSectionLabel";

export function SidebarItutuGroupLabel({
  state,
  isExpanded,
  onExpandedChange,
}: {
  state: ThreadOrganizationState;
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const result = useItutuThreadCount(state);
  const count =
    result.status === "loaded"
      ? result.count.toLocaleString()
      : result.status === "error"
        ? "—"
        : "…";
  const countLabel =
    result.status === "loaded"
      ? `${count} ${result.count === 1 ? "thread" : "threads"}`
      : result.status === "error"
        ? "Thread count unavailable"
        : "Loading thread count";

  return (
    <SidebarSectionLabel isExpanded={isExpanded} onExpandedChange={onExpandedChange}>
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} shrink-0`} />
        <span>{ITUTU_STATE_LABELS[state]}</span>
        <span
          data-slot="itutu-thread-count"
          className="tabular-nums opacity-0 transition-opacity group-hover/project-header:opacity-100 group-focus-within/project-header:opacity-100"
          aria-label={countLabel}
        >
          ({count})
        </span>
      </span>
    </SidebarSectionLabel>
  );
}
