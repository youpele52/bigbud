import { type MessageId } from "@bigbud/contracts";
import { type PendingUserInput } from "../../../logic/session";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../../lib/turnDiffTree";
import { type ProposedPlan, type TurnDiffSummary } from "../../../models/types";
import { estimateTimelineMessageHeight, estimateWrappedLineCount } from "../../timelineHeight";
import {
  activityAccordionId,
  type ActivityAccordionOpenById,
} from "../common/ActivityAccordion.state";
import { isTimelineRowAccordionOpen } from "./MessagesTimeline.accordion";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveWorkGroupPresentation } from "./MessagesTimeline.workGroup.logic";
import { workEntryDetailBlocks } from "./MessagesTimeline.workEntry.logic";

// Heights measured in Chromium at the default 14px root size (see
// MessagesTimeline.accordion.browser.tsx). Every row adds the `pb-4` row gap.
const ROW_GAP_PX = 16;
// Collapsed `section` accordion: py-2 summary around the cap-trimmed header, pb-2 + border.
const SECTION_ACCORDION_COLLAPSED_PX = 36;
// Open `section` panel padding (pt-3 + pb-2).
const SECTION_ACCORDION_PANEL_PADDING_PX = 20;
// `py-0.5` wrapper around thinking and question rows.
const INSET_ROW_PADDING_PX = 4;
// Hover action row (`mt-1`/`gap-1` + an xs button) under answered questions and lone entries.
const OUTSIDE_ACTIONS_PX = 28;
// One work entry: `py-1` around a `leading-5` line; entries are `space-y-0.5` apart.
const WORK_ENTRY_PX = 28;
const WORK_ENTRY_GAP_PX = 2;
// In-entry hover actions (`mt-1.5` + xs button) when actions are not hoisted outside.
const WORK_ENTRY_INLINE_ACTIONS_PX = 30;
// Collapsed compact "Details" disclosure under a work entry heading.
const WORK_ENTRY_DETAILS_COLLAPSED_PX = 15;
// Open details: compact panel padding plus the bordered `<pre>` chrome, capped at max-h-64.
const WORK_ENTRY_DETAILS_PANEL_PX = 24;
const WORK_ENTRY_DETAILS_LINE_PX = 18;
const WORK_ENTRY_DETAILS_CHARS_PER_LINE = 96;
const WORK_ENTRY_DETAILS_MAX_PRE_PX = 256;
// A finished subagent row with its one-line summary.
const SUBAGENT_ROW_PX = 28;
const SUBAGENTS_VISIBLE_WHEN_COLLAPSED = 1;
// Thinking markdown renders text-xs at 1.55 line height across the full timeline width.
const THINKING_LINE_PX = 18.6;
const THINKING_AVG_CHAR_WIDTH_PX = 5.6;
const THINKING_FALLBACK_CHARS_PER_LINE = 120;
// Answered questions: text-sm lines are 20px. Label + mb-1, question + mb-1.5, options with
// space-y-1, and the mt-4 "Your answer" block (label + mb-1 + answer); questions space-y-4.
const QUESTION_LABEL_PX = 24;
const QUESTION_TEXT_PX = 26;
const QUESTION_OPTION_PX = 24;
const QUESTION_ANSWER_PX = 60;
const QUESTION_GAP_PX = 16;

export interface MessagesTimelineRowEstimateInput {
  timelineWidthPx: number | null;
  expandedWorkGroups?: Readonly<Record<string, boolean>>;
  activityAccordionOpenById?: ActivityAccordionOpenById;
  turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
}

export function estimateMessagesTimelineRowHeight(
  row: MessagesTimelineRow,
  input: MessagesTimelineRowEstimateInput,
): number {
  const accordionOpen = isTimelineRowAccordionOpen(row, input.activityAccordionOpenById);
  switch (row.kind) {
    case "work":
      return estimateWorkRowHeight(row, accordionOpen, input);
    case "thinking":
      return (
        ROW_GAP_PX +
        INSET_ROW_PADDING_PX +
        SECTION_ACCORDION_COLLAPSED_PX +
        (accordionOpen
          ? SECTION_ACCORDION_PANEL_PADDING_PX + estimateThinkingBodyHeight(row, input)
          : 0)
      );
    case "proposed-plan":
      return estimateTimelineProposedPlanHeight(row.proposedPlan);
    case "subagents-history": {
      const visibleAgents = Math.min(row.agents.length, SUBAGENTS_VISIBLE_WHEN_COLLAPSED);
      // "Show N more" sits in the header's actions slot, so it adds no height.
      const panel = SECTION_ACCORDION_PANEL_PADDING_PX + visibleAgents * SUBAGENT_ROW_PX;
      return ROW_GAP_PX + SECTION_ACCORDION_COLLAPSED_PX + (accordionOpen ? panel : 0);
    }
    case "user-input-question":
      if (!row.answers) return estimateUserInputQuestionRowHeight(row.pendingUserInput);
      return (
        ROW_GAP_PX +
        INSET_ROW_PADDING_PX +
        SECTION_ACCORDION_COLLAPSED_PX +
        OUTSIDE_ACTIONS_PX +
        (accordionOpen
          ? SECTION_ACCORDION_PANEL_PADDING_PX +
            estimateAnsweredQuestionsHeight(row.pendingUserInput)
          : 0)
      );
    case "working":
      return 40;
    case "message": {
      let estimate = estimateTimelineMessageHeight(row.message, {
        timelineWidthPx: input.timelineWidthPx,
      });
      const turnDiffSummary = input.turnDiffSummaryByAssistantMessageId?.get(row.message.id);
      if (turnDiffSummary && turnDiffSummary.files.length > 0) {
        estimate += estimateChangedFilesCardHeight(turnDiffSummary);
      }
      return estimate;
    }
  }
}

function estimateWorkRowHeight(
  row: Extract<MessagesTimelineRow, { kind: "work" }>,
  accordionOpen: boolean,
  input: Pick<MessagesTimelineRowEstimateInput, "expandedWorkGroups" | "activityAccordionOpenById">,
): number {
  const isExpanded = input.expandedWorkGroups?.[row.id] ?? false;
  const presentation = deriveWorkGroupPresentation(row, isExpanded);
  const outsideActions = presentation.showSingleEntryActionsOutside ? OUTSIDE_ACTIONS_PX : 0;
  if (!accordionOpen) {
    return ROW_GAP_PX + SECTION_ACCORDION_COLLAPSED_PX + outsideActions;
  }

  let entries = Math.max(0, presentation.visibleEntries.length - 1) * WORK_ENTRY_GAP_PX;
  for (const entry of presentation.visibleEntries) {
    entries += WORK_ENTRY_PX;
    if (!presentation.showSingleEntryActionsOutside) entries += WORK_ENTRY_INLINE_ACTIONS_PX;
    const blocks = workEntryDetailBlocks(entry);
    if (blocks.length === 0) continue;
    entries += WORK_ENTRY_DETAILS_COLLAPSED_PX;
    if (input.activityAccordionOpenById?.[activityAccordionId("work-entry", entry.id)]) {
      entries += estimateWorkEntryDetailsPanelHeight(blocks);
    }
  }
  const chrome = SECTION_ACCORDION_COLLAPSED_PX + SECTION_ACCORDION_PANEL_PADDING_PX;
  return ROW_GAP_PX + chrome + entries + outsideActions;
}

function estimateWorkEntryDetailsPanelHeight(blocks: ReadonlyArray<string>): number {
  let height = 0;
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .reduce(
        (sum, line) =>
          sum + Math.max(1, Math.ceil(line.length / WORK_ENTRY_DETAILS_CHARS_PER_LINE)),
        0,
      );
    height +=
      WORK_ENTRY_DETAILS_PANEL_PX +
      Math.min(lines * WORK_ENTRY_DETAILS_LINE_PX, WORK_ENTRY_DETAILS_MAX_PRE_PX);
  }
  return height;
}

function estimateThinkingBodyHeight(
  row: Extract<MessagesTimelineRow, { kind: "thinking" }>,
  input: Pick<MessagesTimelineRowEstimateInput, "timelineWidthPx">,
): number {
  const text = row.entry.detail?.trim() || row.entry.label;
  const charsPerLine =
    input.timelineWidthPx && input.timelineWidthPx > 0
      ? Math.max(20, Math.floor(input.timelineWidthPx / THINKING_AVG_CHAR_WIDTH_PX))
      : THINKING_FALLBACK_CHARS_PER_LINE;
  return estimateWrappedLineCount(text, charsPerLine) * THINKING_LINE_PX;
}

function estimateAnsweredQuestionsHeight(pendingUserInput: PendingUserInput): number {
  let height = 0;
  for (const [index, question] of pendingUserInput.questions.entries()) {
    if (index > 0) height += QUESTION_GAP_PX;
    // Mirrors UserInputQuestions: a generic "Question" header is omitted from history.
    if (question.header.trim().toLowerCase() !== "question") height += QUESTION_LABEL_PX;
    if (question.header && question.question !== question.header) height += QUESTION_TEXT_PX;
    if (question.options.length > 0) height += question.options.length * QUESTION_OPTION_PX - 4;
    height += QUESTION_ANSWER_PX;
  }
  return height;
}

function estimateTimelineProposedPlanHeight(proposedPlan: ProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

function estimateUserInputQuestionRowHeight(pendingUserInput: PendingUserInput): number {
  // Card chrome + header + question rows with options
  const optionLineCount = pendingUserInput.questions.reduce((sum, q) => sum + q.options.length, 0);
  return 80 + pendingUserInput.questions.length * 40 + optionLineCount * 28;
}

function estimateChangedFilesCardHeight(turnDiffSummary: TurnDiffSummary): number {
  const treeNodes = buildTurnDiffTree(turnDiffSummary.files);
  const visibleNodeCount = countTurnDiffTreeNodes(treeNodes);

  // Card chrome: top/bottom padding, header row, and tree spacing.
  return 60 + visibleNodeCount * 25;
}

function countTurnDiffTreeNodes(nodes: ReadonlyArray<TurnDiffTreeNode>): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === "directory") {
      count += countTurnDiffTreeNodes(node.children);
    }
  }
  return count;
}
