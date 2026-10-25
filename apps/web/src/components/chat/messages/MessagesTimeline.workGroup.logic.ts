import { type WorkLogEntry } from "../../../logic/session";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

export interface WorkGroupPresentation {
  readonly visibleEntries: ReadonlyArray<WorkLogEntry>;
  readonly hasOverflow: boolean;
  readonly hiddenCount: number;
  readonly title: string;
  /** A lone visible entry keeps its hover actions outside the accordion. */
  readonly showSingleEntryActionsOutside: boolean;
}

/** Shared by the work-group renderer and the row height estimator so both agree. */
export function deriveWorkGroupPresentation(
  row: { readonly groupedEntries: ReadonlyArray<WorkLogEntry> },
  isExpanded: boolean,
): WorkGroupPresentation {
  const groupedEntries = row.groupedEntries;
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  return {
    visibleEntries,
    hasOverflow,
    hiddenCount: groupedEntries.length - visibleEntries.length,
    title: `${onlyToolEntries ? "Tool calls" : "Work log"} (${groupedEntries.length})`,
    showSingleEntryActionsOutside: visibleEntries.length === 1,
  };
}
