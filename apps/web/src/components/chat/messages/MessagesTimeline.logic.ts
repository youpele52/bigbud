import { type OrchestrationTask } from "@bigbud/contracts";
import { type TimelineEntry, type PendingUserInput } from "../../../logic/session";
import { type WorkLogEntry } from "../../../logic/session";
import { type ChatMessage, type ProposedPlan } from "../../../models/types";

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      streaming: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      showAssistantCopyButton: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "subagents-history";
      id: string;
      createdAt: string;
      agents: OrchestrationTask[];
    }
  | {
      kind: "user-input-question";
      id: string;
      createdAt: string;
      pendingUserInput: PendingUserInput;
      answers?: Readonly<Record<string, unknown>>;
      answeredAt?: string;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function isLiveTurnEntry(
  createdAt: string,
  input: { isWorking: boolean; activeTurnStartedAtMs: number },
): boolean {
  const createdAtMs = Date.parse(createdAt);
  return (
    input.isWorking &&
    !Number.isNaN(input.activeTurnStartedAtMs) &&
    !Number.isNaN(createdAtMs) &&
    createdAtMs >= input.activeTurnStartedAtMs
  );
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  historicalAgents?: ReadonlyArray<OrchestrationTask>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const activeTurnStartedAtMs =
    typeof input.activeTurnStartedAt === "string"
      ? Date.parse(input.activeTurnStartedAt)
      : Number.NaN;
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const liveInput = { isWorking: input.isWorking, activeTurnStartedAtMs };
  const finalAssistantMessageIdByTurnId = new Map<string, string>();

  for (const timelineEntry of input.timelineEntries) {
    if (timelineEntry?.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    if (!timelineEntry.message.turnId) {
      continue;
    }
    finalAssistantMessageIdByTurnId.set(timelineEntry.message.turnId, timelineEntry.message.id);
  }

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "thinking") {
      nextRows.push({
        kind: "thinking",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        entry: timelineEntry.entry,
        streaming: isLiveTurnEntry(timelineEntry.createdAt, liveInput),
      });
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "user-input-question") {
      nextRows.push({
        kind: "user-input-question",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        pendingUserInput: timelineEntry.pendingUserInput,
        ...(timelineEntry.answers ? { answers: timelineEntry.answers } : {}),
        ...(timelineEntry.answeredAt ? { answeredAt: timelineEntry.answeredAt } : {}),
      });
      continue;
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        (timelineEntry.message.turnId === null || timelineEntry.message.turnId === undefined
          ? true
          : finalAssistantMessageIdByTurnId.get(timelineEntry.message.turnId) ===
            timelineEntry.message.id),
    });
  }

  insertHistoricalSubagentRows(nextRows, input.historicalAgents ?? []);

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function insertHistoricalSubagentRows(
  rows: MessagesTimelineRow[],
  agents: ReadonlyArray<OrchestrationTask>,
): void {
  const groups = new Map<string, OrchestrationTask[]>();
  for (const agent of agents) {
    const key = agent.turnId ? `turn:${agent.turnId}` : `time:${agent.updatedAt}`;
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  const historyRows = [...groups.entries()]
    .map(([key, groupedAgents]) => ({
      kind: "subagents-history" as const,
      id: `subagents-history:${key}`,
      createdAt: groupedAgents.reduce(
        (latest, agent) => (agent.updatedAt > latest ? agent.updatedAt : latest),
        groupedAgents[0]!.updatedAt,
      ),
      agents: groupedAgents,
      turnId: groupedAgents[0]?.turnId,
    }))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const history of historyRows) {
    const turnIndex = history.turnId
      ? rows.findLastIndex((row) => row.kind === "message" && row.message.turnId === history.turnId)
      : -1;
    const timestampIndex = rows.findIndex(
      (row) => typeof row.createdAt === "string" && row.createdAt > history.createdAt,
    );
    const index =
      turnIndex >= 0 ? turnIndex + 1 : timestampIndex >= 0 ? timestampIndex : rows.length;
    const { turnId: _turnId, ...row } = history;
    rows.splice(index, 0, row);
  }
}
