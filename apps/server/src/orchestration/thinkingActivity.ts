import {
  EventId,
  type ProviderRuntimeEvent,
  type ThinkingActivityPayload,
  type ThinkingActivityStreamKind,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";

export const THINKING_ACTIVITY_HEAD_CHARS = 3_000;
export const THINKING_ACTIVITY_TAIL_CHARS = 7_000;
export const THINKING_ACTIVITY_PERSIST_LIMIT =
  THINKING_ACTIVITY_HEAD_CHARS + THINKING_ACTIVITY_TAIL_CHARS;
export const THINKING_ACTIVITY_TRUNCATION_MARKER = "\n\n[... truncated ...]\n\n";

export interface BufferedThinkingActivity {
  readonly activityId: EventId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly streamKind: ThinkingActivityStreamKind;
  readonly createdAt: string;
  readonly fullCharCount: number;
  readonly mode: "full" | "truncated";
  readonly fullText: string;
  readonly head: string;
  readonly tail: string;
}

export function isThinkingStreamKind(
  streamKind: string | undefined,
): streamKind is ThinkingActivityStreamKind {
  return streamKind === "reasoning_text" || streamKind === "reasoning_summary_text";
}

export function isThinkingContentDeltaEvent(event: ProviderRuntimeEvent): event is Extract<
  ProviderRuntimeEvent,
  {
    type: "content.delta";
    payload: {
      streamKind: ThinkingActivityStreamKind;
      delta: string;
    };
  }
> {
  return event.type === "content.delta" && isThinkingStreamKind(event.payload.streamKind);
}

export function thinkingActivityIdFromRuntimeEvent(input: {
  readonly threadId: ProviderRuntimeEvent["threadId"];
  readonly turnId: ProviderRuntimeEvent["turnId"];
  readonly itemId: ProviderRuntimeEvent["itemId"];
  readonly streamKind: ThinkingActivityStreamKind;
}): EventId {
  const turnSegment = input.turnId ?? "none";
  const itemSegment = input.itemId ?? "none";
  return EventId.makeUnsafe(
    `thinking:${input.threadId}:turn:${turnSegment}:item:${itemSegment}:${input.streamKind}`,
  );
}

export function thinkingActivityKind(streamKind: ThinkingActivityStreamKind): string {
  return streamKind === "reasoning_summary_text" ? "thinking.summary" : "thinking.stream";
}

export function thinkingActivitySummary(streamKind: ThinkingActivityStreamKind): string {
  return streamKind === "reasoning_summary_text" ? "Thinking summary" : "Thinking";
}

export function createBufferedThinkingActivity(input: {
  readonly activityId: EventId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly streamKind: ThinkingActivityStreamKind;
  readonly createdAt: string;
  readonly delta: string;
}): BufferedThinkingActivity {
  const fullCharCount = input.delta.length;
  if (fullCharCount <= THINKING_ACTIVITY_PERSIST_LIMIT) {
    return {
      activityId: input.activityId,
      threadId: input.threadId,
      turnId: input.turnId,
      streamKind: input.streamKind,
      createdAt: input.createdAt,
      fullCharCount,
      mode: "full",
      fullText: input.delta,
      head: "",
      tail: "",
    };
  }

  return {
    activityId: input.activityId,
    threadId: input.threadId,
    turnId: input.turnId,
    streamKind: input.streamKind,
    createdAt: input.createdAt,
    fullCharCount,
    mode: "truncated",
    fullText: "",
    head: input.delta.slice(0, THINKING_ACTIVITY_HEAD_CHARS),
    tail: input.delta.slice(-THINKING_ACTIVITY_TAIL_CHARS),
  };
}

export function appendBufferedThinkingActivity(
  current: BufferedThinkingActivity,
  delta: string,
): BufferedThinkingActivity {
  if (delta.length === 0) {
    return current;
  }

  if (current.mode === "full") {
    const nextFullText = `${current.fullText}${delta}`;
    if (nextFullText.length <= THINKING_ACTIVITY_PERSIST_LIMIT) {
      return {
        ...current,
        fullCharCount: current.fullCharCount + delta.length,
        fullText: nextFullText,
      };
    }

    return {
      ...current,
      fullCharCount: current.fullCharCount + delta.length,
      mode: "truncated",
      fullText: "",
      head: nextFullText.slice(0, THINKING_ACTIVITY_HEAD_CHARS),
      tail: nextFullText.slice(-THINKING_ACTIVITY_TAIL_CHARS),
    };
  }

  return {
    ...current,
    fullCharCount: current.fullCharCount + delta.length,
    tail: `${current.tail}${delta}`.slice(-THINKING_ACTIVITY_TAIL_CHARS),
  };
}

export function toThinkingActivityPayload(
  entry: BufferedThinkingActivity,
): ThinkingActivityPayload {
  const detail =
    entry.mode === "full"
      ? entry.fullText
      : `${entry.head}${THINKING_ACTIVITY_TRUNCATION_MARKER}${entry.tail}`;

  return {
    detail,
    streamKind: entry.streamKind,
    fullCharCount: Math.max(0, entry.fullCharCount),
    persistedCharCount: detail.length,
    truncated: entry.mode === "truncated",
  };
}

export function thinkingActivityThreadPrefix(threadId: ThreadId): string {
  return `thinking:${threadId}:`;
}

export function thinkingActivityTurnPrefix(threadId: ThreadId, turnId: string): string {
  return `${thinkingActivityThreadPrefix(threadId)}turn:${turnId}:`;
}

export function thinkingActivityItemToken(itemId: string): string {
  return `:item:${itemId}:`;
}
