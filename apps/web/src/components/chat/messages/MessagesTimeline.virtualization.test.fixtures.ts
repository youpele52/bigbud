import { MessageId, type OrchestrationTask, type TurnId } from "@bigbud/contracts";
import { type ComponentProps } from "react";

import { deriveTimelineEntries } from "../../../logic/session";
import { type WorkLogEntry } from "../../../logic/session";
import { type AnsweredUserInput } from "../../../logic/session/session.userInputHistory.logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../../models/types";
import { type MessagesTimeline } from "./MessagesTimeline";

export const MARKDOWN_CWD = "/repo/project";

export function isoAt(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 2, 17, 19, 12, 28) + offsetSeconds * 1_000).toISOString();
}

export function createMessage(input: {
  id: string;
  role: ChatMessage["role"];
  text: string;
  offsetSeconds: number;
  attachments?: ChatMessage["attachments"];
}): ChatMessage {
  return {
    id: MessageId.makeUnsafe(input.id),
    role: input.role,
    text: input.text,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    createdAt: isoAt(input.offsetSeconds),
    ...(input.role === "assistant" ? { completedAt: isoAt(input.offsetSeconds + 1) } : {}),
    streaming: false,
  };
}

export function createToolWorkEntry(input: {
  id: string;
  offsetSeconds: number;
  label?: string;
  detail?: string;
}): WorkLogEntry {
  return {
    id: input.id,
    createdAt: isoAt(input.offsetSeconds),
    label: input.label ?? "exec_command completed",
    ...(input.detail ? { detail: input.detail } : {}),
    tone: "tool",
    toolTitle: "exec_command",
  };
}

export function createPlan(input: {
  id: string;
  offsetSeconds: number;
  planMarkdown: string;
}): ProposedPlan {
  return {
    id: input.id as ProposedPlan["id"],
    turnId: null,
    planMarkdown: input.planMarkdown,
    implementedAt: null,
    implementationThreadId: null,
    createdAt: isoAt(input.offsetSeconds),
    updatedAt: isoAt(input.offsetSeconds + 1),
  };
}

export function createBaseTimelineProps(input: {
  messages?: ChatMessage[];
  proposedPlans?: ProposedPlan[];
  workEntries?: WorkLogEntry[];
  answeredUserInputs?: AnsweredUserInput[];
  historicalAgents?: OrchestrationTask[];
  isWorking?: boolean;
  activeTurnStartedAt?: string | null;
  expandedWorkGroups?: Record<string, boolean>;
  activityAccordionOpenById?: Record<string, boolean>;
  completionDividerBeforeEntryId?: string | null;
  turnDiffSummaryByAssistantMessageId?: Map<MessageId, TurnDiffSummary>;
  onVirtualizerSnapshot?: ComponentProps<typeof MessagesTimeline>["onVirtualizerSnapshot"];
}): Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer"> {
  return {
    isWorking: input.isWorking ?? false,
    activeTurnInProgress: input.isWorking ?? false,
    activeTurnStartedAt: input.activeTurnStartedAt ?? null,
    timelineEntries: deriveTimelineEntries(
      input.messages ?? [],
      input.proposedPlans ?? [],
      input.workEntries ?? [],
      [],
      input.answeredUserInputs ?? [],
    ),
    ...(input.historicalAgents ? { historicalAgents: input.historicalAgents } : {}),
    completionDividerBeforeEntryId: input.completionDividerBeforeEntryId ?? null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: input.turnDiffSummaryByAssistantMessageId ?? new Map(),
    nowIso: isoAt(10_000),
    expandedWorkGroups: input.expandedWorkGroups ?? {},
    onToggleWorkGroup: () => {},
    activityAccordionOpenById: input.activityAccordionOpenById ?? {},
    onSetActivityAccordionOpen: () => {},
    changedFilesExpandedByTurnId: {},
    onSetChangedFilesExpanded: () => {},
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: MARKDOWN_CWD,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: MARKDOWN_CWD,
    ...(input.onVirtualizerSnapshot ? { onVirtualizerSnapshot: input.onVirtualizerSnapshot } : {}),
  };
}

export function createFillerMessages(input: {
  prefix: string;
  startOffsetSeconds: number;
  pairCount: number;
}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < input.pairCount; index += 1) {
    const baseOffset = input.startOffsetSeconds + index * 4;
    messages.push(
      createMessage({
        id: `${input.prefix}-user-${index}`,
        role: "user",
        text: `filler user message ${index}`,
        offsetSeconds: baseOffset,
      }),
    );
    messages.push(
      createMessage({
        id: `${input.prefix}-assistant-${index}`,
        role: "assistant",
        text: `filler assistant message ${index}`,
        offsetSeconds: baseOffset + 1,
      }),
    );
  }
  return messages;
}

export function createChangedFilesSummary(
  targetMessageId: MessageId,
  files: TurnDiffSummary["files"],
): Map<MessageId, TurnDiffSummary> {
  return new Map([
    [
      targetMessageId,
      {
        turnId: "turn-changed-files" as TurnId,
        completedAt: isoAt(10),
        assistantMessageId: targetMessageId,
        files,
      },
    ],
  ]);
}
