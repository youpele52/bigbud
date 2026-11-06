import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { HandPointingLeft03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import type { InyosiraCountResult } from "./Sidebar.inyosira.count";
import { INYOSIRA_STATE_LABELS } from "./Sidebar.inyosira.logic";
import { SidebarSectionLabel } from "./SidebarSectionLabel";

export function SidebarInyosiraGroupLabel({
  state,
  result,
  hasThreads = false,
  isExpanded,
  onExpandedChange,
}: {
  state: ThreadOrganizationState;
  result: InyosiraCountResult;
  hasThreads?: boolean;
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const isEmptyNeedsYou =
    state === "needs-you" && !hasThreads && result.status === "loaded" && result.count === 0;
  // Threads waiting on the user: the count stays shown and an amber hand points at the heading.
  const needsAttention =
    state === "needs-you" && (hasThreads || (result.status === "loaded" && result.count > 0));
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
      <span
        className={`inline-flex items-center gap-2 ${isEmptyNeedsYou ? "text-muted-foreground" : ""}`}
      >
        <span aria-hidden="true" className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} shrink-0`} />
        <span>{INYOSIRA_STATE_LABELS[state]}</span>
        {!isEmptyNeedsYou ? (
          <span
            data-slot="inyosira-thread-count"
            className={`tabular-nums transition-opacity group-hover/project-header:opacity-100 group-focus-within/project-header:opacity-100 ${isExpanded || needsAttention ? "opacity-100" : "opacity-0"}`}
            aria-label={countLabel}
          >
            ({count})
          </span>
        ) : null}
        {needsAttention ? (
          <HugeiconsIcon
            aria-hidden="true"
            data-slot="inyosira-needs-you-hand"
            icon={HandPointingLeft03Icon}
            size={14}
            strokeWidth={2}
            className="inyosira-needs-you-hand -ml-0.5 size-3.5 shrink-0 text-warning-foreground"
          />
        ) : null}
      </span>
    </SidebarSectionLabel>
  );
}
