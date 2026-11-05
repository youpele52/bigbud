import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";

import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import type { InyosiraCountResult } from "./Sidebar.inyosira.count";
import { INYOSIRA_STATE_LABELS } from "./Sidebar.inyosira.logic";
import { SidebarSectionLabel } from "./SidebarSectionLabel";

export function SidebarInyosiraGroupLabel({
  state,
  result,
  isExpanded,
  onExpandedChange,
}: {
  state: ThreadOrganizationState;
  result: InyosiraCountResult;
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
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
        <span>{INYOSIRA_STATE_LABELS[state]}</span>
        <span
          data-slot="inyosira-thread-count"
          className={`tabular-nums transition-opacity group-hover/project-header:opacity-100 group-focus-within/project-header:opacity-100 ${isExpanded ? "opacity-100" : "opacity-0"}`}
          aria-label={countLabel}
        >
          ({count})
        </span>
      </span>
    </SidebarSectionLabel>
  );
}
