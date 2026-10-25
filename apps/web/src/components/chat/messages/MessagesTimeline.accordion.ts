import {
  activityAccordionId,
  controlledActivityAccordionProps,
  resolveActivityAccordionOpen,
  type ActivityAccordionControl,
  type ActivityAccordionOpenById,
  type SetActivityAccordionOpen,
} from "../common/ActivityAccordion.state";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Persisted accordion id of a timeline row, or `null` when the row renders no accordion. */
export function timelineRowAccordionId(row: MessagesTimelineRow): string | null {
  switch (row.kind) {
    case "work":
      return activityAccordionId("work", row.id);
    case "thinking":
      return activityAccordionId("thinking", row.id);
    case "subagents-history":
      return activityAccordionId("subagents", row.id);
    case "user-input-question":
      return row.answers ? activityAccordionId("question", row.id) : null;
    default:
      return null;
  }
}

/** Whether a row's accordion renders open; rows without an accordion count as open. */
export function isTimelineRowAccordionOpen(
  row: MessagesTimelineRow,
  openById: ActivityAccordionOpenById | undefined,
): boolean {
  const id = timelineRowAccordionId(row);
  if (id === null) return true;
  return resolveActivityAccordionOpen(openById, id);
}

export function timelineRowAccordionControl(
  row: MessagesTimelineRow,
  openById: ActivityAccordionOpenById,
  onSetOpen: SetActivityAccordionOpen,
): ActivityAccordionControl | undefined {
  const id = timelineRowAccordionId(row);
  if (id === null) return undefined;
  return controlledActivityAccordionProps({
    id,
    openById,
    onSetOpen,
  });
}

/** Work-entry "Details" disclosures, persisted like the row accordions. */
export function workEntryDetailsAccordionControl(
  entryId: string,
  openById: ActivityAccordionOpenById,
  onSetOpen: SetActivityAccordionOpen,
): ActivityAccordionControl {
  return controlledActivityAccordionProps({
    id: activityAccordionId("work-entry", entryId),
    openById,
    onSetOpen,
  });
}
