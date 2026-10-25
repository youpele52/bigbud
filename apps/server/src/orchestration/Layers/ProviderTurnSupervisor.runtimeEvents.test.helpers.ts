import {
  EventId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";

let sequence = 0;
const createdAt = "2026-10-22T10:00:00.000Z";

const base = (threadId: ThreadId, turnId: TurnId | null, at = createdAt) => ({
  eventId: EventId.makeUnsafe(`runtime-event-${(sequence += 1)}`),
  provider: "claudeAgent" as const,
  threadId,
  createdAt: at,
  ...(turnId ? { turnId } : {}),
});

/** `at` is the event's own time, which the provider set when it produced the event. */
export const turnStarted = (
  threadId: ThreadId,
  turnId: TurnId,
  at?: string,
): ProviderRuntimeEvent => ({
  ...base(threadId, turnId, at),
  type: "turn.started",
  payload: {},
});

export const turnCompleted = (
  threadId: ThreadId,
  turnId: TurnId,
  state: "completed" | "failed" | "interrupted" | "cancelled",
  at?: string,
): ProviderRuntimeEvent => ({
  ...base(threadId, turnId, at),
  type: "turn.completed",
  payload: { state },
});

/** Streamed assistant text: meaningful progress. */
export const contentDelta = (
  threadId: ThreadId,
  turnId: TurnId,
  at: string,
): ProviderRuntimeEvent => ({
  ...base(threadId, turnId, at),
  type: "content.delta",
  payload: { streamKind: "assistant_text", delta: "more of the story" },
});

export const toolItem = (
  type: "item.started" | "item.completed",
  threadId: ThreadId,
  turnId: TurnId | null,
  itemId: string | null,
  title: string,
): ProviderRuntimeEvent =>
  ({
    ...base(threadId, turnId),
    ...(itemId ? { itemId: RuntimeItemId.makeUnsafe(itemId) } : {}),
    type,
    payload: { itemType: "command_execution", title },
  }) as ProviderRuntimeEvent;

export const sessionExited = (threadId: ThreadId): ProviderRuntimeEvent => ({
  ...base(threadId, null),
  type: "session.exited",
  payload: { reason: "app-server exited" },
});

/** A tool activity row as ingestion writes it. */
export function toolActivity(input: {
  readonly kind: "tool.started" | "tool.completed" | "tool.progress";
  readonly title: string;
  readonly itemId?: string;
  readonly turnId: TurnId | null;
  readonly createdAt?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(`activity-${(sequence += 1)}`),
    tone: "tool",
    kind: input.kind,
    summary: input.kind === "tool.started" ? `${input.title} started` : input.title,
    payload: { itemType: "command_execution", ...(input.itemId ? { itemId: input.itemId } : {}) },
    turnId: input.turnId,
    createdAt: input.createdAt ?? createdAt,
  };
}

/** Upserts by ID, as the read model does for repeated activity rows. */
export function upsertActivities(
  rows: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const byId = new Map<string, OrchestrationThreadActivity>();
  for (const row of rows) byId.set(String(row.id), row);
  return [...byId.values()];
}
