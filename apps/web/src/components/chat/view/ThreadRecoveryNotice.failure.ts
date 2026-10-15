import type { MessageId } from "@bigbud/contracts";

import type { ChatMessage } from "../../../models/types/app.types";

export const TURN_START_FAILED_ACTIVITY_KIND = "provider.turn.start.failed";
/** Failure classes in-place recovery cannot fix; only a new thread continues (plan D16). */
export const FORK_ONLY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "session-dead",
  "unsafe-to-replay",
  "provider-unavailable",
]);

/** The latest user message's turn-start failure, read from server state only (plan D21). */
export interface ServerTurnFailure {
  readonly pendingMessageId: MessageId;
  readonly failureEventId: string;
  /** Empty when the server did not classify the failure. */
  readonly failureClass: string;
}

interface FailureActivity {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

/**
 * Survives a reload: the failure activity and the user message share the turn-start command's
 * timestamp, so comparing them never mixes clocks. A turn of the thread answering after that
 * message (message order, not timestamps) clears the failure.
 */
export function deriveServerTurnFailure(thread: {
  readonly messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "turnId" | "createdAt">>;
  readonly activities: ReadonlyArray<FailureActivity>;
}): ServerTurnFailure | null {
  const index = thread.messages.findLastIndex((message) => message.role === "user");
  const pending = thread.messages[index];
  if (pending === undefined) return null;
  const answered = thread.messages
    .slice(index + 1)
    .some(
      (message) =>
        message.role === "assistant" && message.turnId !== null && message.turnId !== undefined,
    );
  if (answered) return null;
  const failure = thread.activities.findLast(
    (activity) =>
      activity.kind === TURN_START_FAILED_ACTIVITY_KIND && activity.createdAt >= pending.createdAt,
  );
  if (failure === undefined) return null;
  const payload = failure.payload as { failureClass?: unknown } | null | undefined;
  return {
    pendingMessageId: pending.id,
    failureEventId: failure.id,
    failureClass: typeof payload?.failureClass === "string" ? payload.failureClass : "",
  };
}
