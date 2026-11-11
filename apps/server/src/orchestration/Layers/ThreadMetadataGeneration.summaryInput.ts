import type {
  OrchestrationMessage,
  OrchestrationThread,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";

const INITIAL_MESSAGE_COUNT = 5;
const REFRESH_MESSAGE_INTERVAL = 10;
const TRANSCRIPT_MAX_CHARS = 8_000;

function isVisibleSummaryMessage(message: OrchestrationMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

export function countVisibleSummaryMessages(messages: ReadonlyArray<OrchestrationMessage>): number {
  return messages.filter(isVisibleSummaryMessage).length;
}

export function shouldRefreshThreadElevatorSummary(input: {
  readonly thread: Pick<
    OrchestrationThread,
    "archivedAt" | "deletingAt" | "deletedAt" | "elevatorSummaryMessageCount" | "messages"
  >;
  readonly attemptedFrontier?: number;
}): boolean {
  if (input.thread.archivedAt || input.thread.deletingAt || input.thread.deletedAt) return false;
  const count = countVisibleSummaryMessages(input.thread.messages);
  if (count < INITIAL_MESSAGE_COUNT) return false;
  const frontier = Math.max(input.thread.elevatorSummaryMessageCount, input.attemptedFrontier ?? 0);
  return frontier === 0 || count >= frontier + REFRESH_MESSAGE_INTERVAL;
}

/** Slice before formatting so enormous responses never create an unbounded temporary section. */
function boundedTranscriptSection(message: OrchestrationMessage, budget: number): string {
  if (!isVisibleSummaryMessage(message)) return "";
  const heading = message.role === "assistant" ? "ASSISTANT:\n" : "USER:\n";
  if (budget <= heading.length) return "";
  const start = message.text.search(/\S/u);
  if (start < 0) return "";
  let text = message.text.slice(start, start + budget - heading.length).trimEnd();
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return text ? `${heading}${text}` : "";
}

/** Keep chronological, bounded context, reserving room for the most recent readable user intent. */
export function buildElevatorSummaryTranscript(
  messages: ReadonlyArray<OrchestrationMessage>,
): string {
  const budget = TRANSCRIPT_MAX_CHARS;
  let userIndex = -1;
  let reserved = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const section = boundedTranscriptSection(message, budget / 2);
    if (!section) continue;
    userIndex = index;
    reserved = section.length;
    break;
  }
  const sections: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0 && used < budget; index -= 1) {
    const isReservedUser = index === userIndex;
    const remaining = budget - used - (sections.length > 0 ? 2 : 0);
    const available = isReservedUser ? remaining : remaining - reserved - (reserved > 0 ? 2 : 0);
    const section = boundedTranscriptSection(messages[index]!, available);
    if (!section) continue;
    used += section.length + (sections.length > 0 ? 2 : 0);
    sections.unshift(section);
    if (isReservedUser) reserved = 0;
  }
  return sections.join("\n\n");
}
