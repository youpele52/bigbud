import { ActivityAccordion } from "../common/ActivityAccordion";
import type {
  ActivityAccordionControl,
  ActivityAccordionOpenById,
  SetActivityAccordionOpen,
} from "../common/ActivityAccordion.state";
import { ActivityOverflowToggle } from "../common/ActivityOverflowToggle";
import { workEntryDetailsAccordionControl } from "./MessagesTimeline.accordion";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveWorkGroupPresentation } from "./MessagesTimeline.workGroup.logic";
import { SimpleWorkEntryRow } from "./MessagesTimeline.workEntry";
import { WorkEntryActionButtons } from "./MessagesTimeline.workEntry.actions";
import type { ExecutionTargetId } from "@bigbud/contracts";

type WorkGroupRow = Extract<MessagesTimelineRow, { kind: "work" }>;

interface MessagesTimelineWorkGroupProps {
  row: WorkGroupRow;
  isExpanded: boolean;
  onToggleWorkGroup: (groupId: string) => void;
  executionTargetId: ExecutionTargetId | undefined;
  /** Persisted group accordion state; collapsed until the user opens it. */
  accordion?: ActivityAccordionControl | undefined;
  activityAccordionOpenById?: ActivityAccordionOpenById | undefined;
  onSetActivityAccordionOpen?: SetActivityAccordionOpen | undefined;
}

export function MessagesTimelineWorkGroup({
  row,
  isExpanded,
  onToggleWorkGroup,
  executionTargetId,
  accordion,
  activityAccordionOpenById,
  onSetActivityAccordionOpen,
}: MessagesTimelineWorkGroupProps) {
  const presentation = deriveWorkGroupPresentation(row, isExpanded);
  const { visibleEntries, showSingleEntryActionsOutside } = presentation;
  const singleVisibleEntry = showSingleEntryActionsOutside ? visibleEntries[0] : undefined;
  const entries = (
    <div className="space-y-0.5">
      {visibleEntries.map((workEntry) => (
        <SimpleWorkEntryRow
          key={`work-row:${workEntry.id}`}
          workEntry={workEntry}
          executionTargetId={executionTargetId}
          showActions={!showSingleEntryActionsOutside}
          detailsAccordion={
            activityAccordionOpenById && onSetActivityAccordionOpen
              ? workEntryDetailsAccordionControl(
                  workEntry.id,
                  activityAccordionOpenById,
                  onSetActivityAccordionOpen,
                )
              : undefined
          }
        />
      ))}
    </div>
  );

  return (
    <div className="group/work-log">
      <ActivityAccordion
        title={presentation.title}
        className="w-full"
        actions={
          presentation.hasOverflow ? (
            <ActivityOverflowToggle
              expanded={isExpanded}
              hiddenCount={presentation.hiddenCount}
              onToggle={() => onToggleWorkGroup(row.id)}
            />
          ) : undefined
        }
        persistentActions={
          singleVisibleEntry ? (
            <WorkEntryActionButtons
              workEntry={singleVisibleEntry}
              executionTargetId={executionTargetId}
            />
          ) : undefined
        }
        {...accordion}
      >
        {entries}
      </ActivityAccordion>
    </div>
  );
}
