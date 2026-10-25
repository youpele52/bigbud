import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type {
  OrchestrationPendingTurnStart,
  OrchestrationThread,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { USER_TURN_BOUND } from "@bigbud/shared/internalTextGeneration";

/** After this long a user's "Send now" may release a queue still held by a pending start. */
export const PENDING_TURN_START_RELEASE_AFTER_MS = 2 * 60_000;

type BoundActivity = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>["payload"]["activity"];

function activityPayloadField(activity: BoundActivity, field: string): unknown {
  const payload = activity.payload;
  return typeof payload === "object" && payload !== null && field in payload
    ? (payload as Record<string, unknown>)[field]
    : undefined;
}

/** The provider accepted the message and is idle again, so its turn cannot still be running. */
function isUserTurnBoundWhileIdle(activity: BoundActivity): boolean {
  // Older activities carry no flag and keep the original behaviour.
  return (
    activity.kind === USER_TURN_BOUND && activityPayloadField(activity, "providerIdle") !== false
  );
}

/**
 * True when `nextPendingTurnStart` could move the gate for this event, judged from the event
 * alone. Projectors use it to skip reading the thread for the many events that cannot.
 */
export function mayChangePendingTurnStart(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.created":
    case "thread.turn-start-requested":
    case "thread.turn-start-failed":
    case "thread.session-stop-requested":
      return true;
    case "thread.session-set": {
      const session = event.payload.session;
      return (
        session.activeTurnId !== null || session.status === "stopped" || session.status === "error"
      );
    }
    case "thread.prompt-queued":
      return event.payload.prompt.alreadySent === true;
    case "thread.activity-appended":
      return isUserTurnBoundWhileIdle(event.payload.activity);
    default:
      return false;
  }
}

/**
 * Durable gate for a requested turn the provider has not bound yet. Starting a
 * provider session for that turn reports `ready` before the turn exists, so the
 * session alone cannot tell queued-prompt dispatch that the thread is busy.
 *
 * Every exit clears it: the turn binds (an active turn, or the provider accepted the
 * message and is idle again), its start fails, the provider refuses it as busy and it
 * is re-queued, the session stops or errors, or the user stops the session.
 * Reconciliation does not write `stopped` for a gated thread whose session is missing,
 * because that is the session the reactor is still starting.
 *
 * Returns `undefined` when the event leaves the gate unchanged.
 */
export function nextPendingTurnStart(
  current: OrchestrationPendingTurnStart | null,
  event: OrchestrationEvent,
): OrchestrationPendingTurnStart | null | undefined {
  if (event.type === "thread.created") return null;
  if (event.type === "thread.turn-start-requested") {
    return {
      messageId: event.payload.messageId,
      requestedAt: event.payload.createdAt,
      requestedSequence: event.sequence,
    };
  }
  if (current === null || !mayChangePendingTurnStart(event)) return undefined;
  switch (event.type) {
    case "thread.turn-start-failed": {
      // Older events carry no message ID and keep the original behaviour: any failure clears.
      const failedMessageId = event.payload.messageId;
      return failedMessageId === undefined || failedMessageId === current.messageId
        ? null
        : undefined;
    }
    case "thread.prompt-queued":
      return event.payload.prompt.id === current.messageId ? null : undefined;
    case "thread.activity-appended":
      return activityPayloadField(event.payload.activity, "messageId") === current.messageId
        ? null
        : undefined;
    default:
      return null;
  }
}

export function hasPendingTurnStart(thread: OrchestrationThread): boolean {
  return thread.pendingTurnStart != null;
}

/** A user's "Send now" may override a gate this old, so a hung start cannot hold the queue. */
export function canUserReleasePendingTurnStart(
  thread: OrchestrationThread,
  releasedAt: string,
): boolean {
  const requestedAt = Date.parse(thread.pendingTurnStart?.requestedAt ?? "");
  const released = Date.parse(releasedAt);
  return (
    Number.isFinite(requestedAt) &&
    Number.isFinite(released) &&
    released - requestedAt >= PENDING_TURN_START_RELEASE_AFTER_MS
  );
}

/**
 * A gate found when the engine loads its state belongs to the previous process. Turn starts
 * are not resumed after a restart, and the message may already have reached the provider,
 * so it is settled rather than resent: stopped, with no active turn, as startup
 * reconciliation does for a session that did not survive.
 */
export function makeOrphanedPendingTurnStartCommand(input: {
  readonly thread: OrchestrationThread;
  readonly createdAt: string;
}): OrchestrationCommand | null {
  const { thread, createdAt } = input;
  if (!hasPendingTurnStart(thread) || thread.deletedAt != null) return null;
  const session = thread.session;
  return {
    type: "thread.session.set",
    commandId: CommandId.makeUnsafe(`server:orphaned-turn-start:${crypto.randomUUID()}`),
    threadId: thread.id,
    session: {
      threadId: thread.id,
      status: "stopped",
      providerName: session?.providerName ?? thread.modelSelection.provider,
      runtimeMode: thread.runtimeMode,
      activeTurnId: null,
      sessionEpoch: session?.sessionEpoch ?? 0,
      reason: null,
      lastError: session?.lastError ?? null,
      updatedAt: createdAt,
    },
    expectedSessionEpoch: session?.sessionEpoch ?? 0,
    createdAt,
  };
}
