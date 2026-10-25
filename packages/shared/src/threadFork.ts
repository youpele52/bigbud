/**
 * Fork lineage rules shared by the server reactor, the fork decider and the web notices (plan D16,
 * D17, D20).
 *
 * @module threadFork
 */
import { THREAD_FORKED_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/orchestration.fork";

export const TURN_START_FAILED_ACTIVITY_KIND = "provider.turn.start.failed";

export interface ForkLineageMessage {
  readonly id: string;
  readonly role: string;
  readonly turnId?: string | null | undefined;
  readonly createdAt: string;
}

export interface ForkLineageActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface LiveAutomaticFork {
  readonly forkThreadId: string;
}

const payloadOf = (activity: ForkLineageActivity): Record<string, unknown> =>
  typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : {};

/**
 * The turn-start failure of this message only. Failures name their message (`payload.messageId`);
 * a legacy failure without it counts only from the message up to the next user message, since a
 * failure carries its own request's timestamp. Another message's failure never applies.
 */
export function findOwnTurnStartFailure<A extends ForkLineageActivity>(
  thread: {
    readonly messages: ReadonlyArray<ForkLineageMessage>;
    readonly activities: ReadonlyArray<A>;
  },
  messageId: string,
): A | undefined {
  const index = thread.messages.findIndex((message) => message.id === messageId);
  const pending = thread.messages[index];
  if (pending === undefined) return undefined;
  const next = thread.messages.slice(index + 1).find((message) => message.role === "user");
  return thread.activities.findLast((activity) => {
    if (activity.kind !== TURN_START_FAILED_ACTIVITY_KIND) return false;
    const bound = payloadOf(activity).messageId;
    if (typeof bound === "string") return bound === messageId;
    return (
      activity.createdAt >= pending.createdAt &&
      (next === undefined || activity.createdAt < next.createdAt)
    );
  });
}

/** Thread ids of the source's automatic forks, newest last. */
export function automaticForkThreadIds(source: {
  readonly activities: ReadonlyArray<ForkLineageActivity>;
}): ReadonlyArray<string> {
  return source.activities.flatMap((activity) => {
    if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) return [];
    const payload = payloadOf(activity);
    return payload.reason !== "manual" && typeof payload.forkThreadId === "string"
      ? [payload.forkThreadId]
      : [];
  });
}

/**
 * The source's newest automatic fork that still exists, while the source stays dead: no turn of
 * the source answered after the message that fork carried. Message order decides, not clocks; only
 * when that message is gone does it compare the fork with answers, both stamped by the server. A
 * deleted fork is ignored, so the source may fork once more.
 */
export function findLiveAutomaticFork(
  source: {
    readonly messages: ReadonlyArray<ForkLineageMessage>;
    readonly activities: ReadonlyArray<ForkLineageActivity>;
  },
  isForkPresent: (forkThreadId: string) => boolean,
): LiveAutomaticFork | null {
  const forked = source.activities.findLast((activity) => {
    if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) return false;
    const payload = payloadOf(activity);
    return (
      payload.reason !== "manual" &&
      typeof payload.forkThreadId === "string" &&
      isForkPresent(payload.forkThreadId)
    );
  });
  if (forked === undefined) return null;
  const payload = payloadOf(forked);
  const anchor = source.messages.findIndex((message) => message.id === payload.pendingMessageId);
  const answered = source.messages.some(
    (message, index) =>
      message.role === "assistant" &&
      message.turnId !== null &&
      message.turnId !== undefined &&
      (anchor >= 0 ? index > anchor : message.createdAt > forked.createdAt),
  );
  return answered ? null : { forkThreadId: payload.forkThreadId as string };
}
