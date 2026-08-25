import { Button, textButtonTypography } from "../../ui/button";
import { MAX_VISIBLE_WORK_LOG_ENTRIES, type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { SimpleWorkEntryRow, WorkEntryActionButtons } from "./MessagesTimeline.workEntry";
import type { ExecutionTargetId } from "@bigbud/contracts";

type WorkGroupRow = Extract<MessagesTimelineRow, { kind: "work" }>;

interface MessagesTimelineWorkGroupProps {
  row: WorkGroupRow;
  isExpanded: boolean;
  onToggleWorkGroup: (groupId: string) => void;
  executionTargetId: ExecutionTargetId | undefined;
}

export function MessagesTimelineWorkGroup({
  row,
  isExpanded,
  onToggleWorkGroup,
  executionTargetId,
}: MessagesTimelineWorkGroupProps) {
  const groupedEntries = row.groupedEntries;
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";
  const showSingleEntryActionsOutside = visibleEntries.length === 1;
  const singleVisibleEntry = showSingleEntryActionsOutside ? visibleEntries[0] : undefined;

  return (
    <div className="group/work-log flex flex-col items-start gap-1">
      <div className="w-full rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
        {showHeader && (
          <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
            <p className={textButtonTypography}>
              {groupLabel} ({groupedEntries.length})
            </p>
            {hasOverflow && (
              <Button
                size="xs"
                variant="text"
                type="button"
                onClick={() => onToggleWorkGroup(row.id)}
              >
                {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
              </Button>
            )}
          </div>
        )}
        <div className="space-y-0.5">
          {visibleEntries.map((workEntry) => (
            <SimpleWorkEntryRow
              key={`work-row:${workEntry.id}`}
              workEntry={workEntry}
              executionTargetId={executionTargetId}
              showActions={!showSingleEntryActionsOutside}
            />
          ))}
        </div>
      </div>
      {singleVisibleEntry ? (
        <div className="flex items-center gap-1.5 px-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/work-log:opacity-100">
          <WorkEntryActionButtons
            workEntry={singleVisibleEntry}
            executionTargetId={executionTargetId}
          />
        </div>
      ) : null}
    </div>
  );
}
