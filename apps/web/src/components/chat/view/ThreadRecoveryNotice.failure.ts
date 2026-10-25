import type { MessageId } from "@bigbud/contracts";
import { findOwnTurnStartFailure } from "@bigbud/shared/threadFork";

import type { ChatMessage } from "../../../models/types/app.types";

/** Failure classes in-place recovery cannot fix; only a new thread continues (plan D16). */
const FORK_ONLY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "session-dead",
  "unsafe-to-replay",
  "provider-unavailable",
]);

/**
 * UI only: failures whose notice offers the manual "Continue in a new thread". Adds
 * `invalid-request` (for example a model no longer offered, D18 decision): the user picks another
 * model in the new thread. The server never forks it automatically.
 */
export const MANUAL_CONTINUE_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  ...FORK_ONLY_FAILURE_CLASSES,
  "invalid-request",
]);

export const isForkOnlyFailureClass = (failureClass: string) =>
  FORK_ONLY_FAILURE_CLASSES.has(failureClass);

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
 * Survives a reload. The failure is that message's own (`findOwnTurnStartFailure`: bound by
 * message id, or for legacy rows by the turn-start command's timestamp, which the message shares),
 * so it never mixes clocks. A turn of the thread answering after that message (message order, not
 * timestamps) clears it.
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
  const failure = findOwnTurnStartFailure(thread, pending.id);
  if (failure === undefined) return null;
  const payload = failure.payload as { failureClass?: unknown } | null | undefined;
  return {
    pendingMessageId: pending.id,
    failureEventId: failure.id,
    failureClass: typeof payload?.failureClass === "string" ? payload.failureClass : "",
  };
}
