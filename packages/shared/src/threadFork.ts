/**
 * Fork lineage rules shared by the server reactor and the web notices (plan D16, D20).
 *
 * @module threadFork
 */
import { THREAD_FORKED_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/orchestration.fork";

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
 * The source's newest automatic fork while the source stays dead: no turn of the source answered
 * after the message that fork carried. Message order decides, not clocks; only when that message
 * is gone does it compare the fork with answers, both stamped by the server.
 */
export function findLiveAutomaticFork(source: {
  readonly messages: ReadonlyArray<ForkLineageMessage>;
  readonly activities: ReadonlyArray<ForkLineageActivity>;
}): LiveAutomaticFork | null {
  const forked = source.activities.findLast((activity) => {
    if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) return false;
    const payload = payloadOf(activity);
    return payload.reason !== "manual" && typeof payload.forkThreadId === "string";
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
