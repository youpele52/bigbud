/**
 * `thread.fork` naming the source's existing fork (plan D20): an automatic fork happens at most
 * once while the source stays dead, so a later message that failed in the source follows that
 * fork only when the user asks, under the same pending-delivery rule as a new fork.
 *
 * @module deciderThreads.fork.carry
 */
import {
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@bigbud/contracts";
import {
  THREAD_FORKED_ACTIVITY_KIND,
  type ThreadForkCommand,
} from "@bigbud/contracts/orchestration/orchestration.fork.ts";
import { Effect } from "effect";

import { withEventBase } from "./deciderHelpers.ts";
import {
  decideThreadTurnStartCommand,
  requireThreadReadyForMutation,
} from "./deciderThreads.turn.start.ts";
import { forkEntityId, resolvePendingDelivery } from "./deciderThreads.fork.logic.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

type DecidedEvent = Omit<OrchestrationEvent, "sequence">;

/** The existing fork of `source` this command carries a not yet carried message into, if any. */
export function findCarryTargetFork(input: {
  readonly readModel: OrchestrationReadModel;
  readonly source: OrchestrationThread;
  readonly command: ThreadForkCommand;
}): OrchestrationThread | undefined {
  const { command, source } = input;
  if (command.pendingMessageId === undefined) return undefined;
  const fork = input.readModel.threads.find((thread) => thread.id === command.threadId);
  if (fork?.forkOrigin === undefined || fork.parentThread?.threadId !== source.id) {
    return undefined;
  }
  const carried = source.activities.some(
    (activity) =>
      activity.kind === THREAD_FORKED_ACTIVITY_KIND &&
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      (activity.payload as Record<string, unknown>).pendingMessageId === command.pendingMessageId,
  );
  return carried ? undefined : fork;
}

export const decideForkPendingCarry = Effect.fn("decideForkPendingCarry")(function* (input: {
  readonly command: ThreadForkCommand;
  readonly readModel: OrchestrationReadModel;
  readonly source: OrchestrationThread;
  readonly fork: OrchestrationThread;
}): Effect.fn.Return<ReadonlyArray<DecidedEvent>, OrchestrationCommandInvariantError> {
  const { command, source, fork } = input;
  yield* requireThreadReadyForMutation({ thread: source, command });
  const pending = source.messages.find(
    (message) => message.id === command.pendingMessageId && message.role === "user",
  );
  if (pending === undefined) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Message '${command.pendingMessageId}' is not a user message of thread '${source.id}'.`,
    });
  }
  // A held message cannot be held inside a running fork; it is never sent again by itself.
  if (resolvePendingDelivery(source, pending) !== "sent") {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail:
        "This message may already have reached the provider, so it is not sent again automatically. Send it again from the continued thread.",
    });
  }
  // The fork's own turn-start rules apply: sent now when idle, queued behind a running turn.
  const started = yield* decideThreadTurnStartCommand({
    command: {
      type: "thread.turn.start",
      commandId: command.commandId,
      threadId: fork.id,
      message: {
        messageId: MessageId.makeUnsafe(forkEntityId("message", fork.id, pending.id)),
        role: "user",
        text: pending.text,
        attachments: pending.attachments ?? [],
      },
      runtimeMode: fork.runtimeMode,
      interactionMode: fork.interactionMode,
      createdAt: command.createdAt,
    },
    readModel: input.readModel,
  });
  const carried: DecidedEvent = {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: source.id,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    type: "thread.activity-appended",
    payload: {
      threadId: source.id,
      activity: {
        id: EventId.makeUnsafe(
          forkEntityId("activity", fork.id, `${THREAD_FORKED_ACTIVITY_KIND}:${pending.id}`),
        ),
        tone: "info",
        kind: THREAD_FORKED_ACTIVITY_KIND,
        summary: "Message sent to the continued thread",
        payload: {
          forkThreadId: fork.id,
          reason: command.reason,
          failureEventId: command.failureEventId ?? null,
          forkPointMessageId: fork.forkOrigin?.forkPointMessageId ?? null,
          pendingDelivery: "sent",
          pendingMessageId: pending.id,
        },
        turnId: null,
        createdAt: command.createdAt,
      },
    },
  } as DecidedEvent;
  return [...started, carried];
});
