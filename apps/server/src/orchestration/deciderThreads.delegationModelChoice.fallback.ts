/**
 * The hold-failure fallback (`expire` with `fallbackStart`) when no hold is pending: the hold never
 * committed, or it was already resolved. Records the fallback and starts the delegated message in
 * one decision. A message id that is already sent or queued is never started again, so an
 * ambiguous hold failure (committed, but reported as failed) cannot send the message twice.
 *
 * @module deciderThreads.delegationModelChoice.fallback
 */
import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@bigbud/contracts";
import type { ThreadDelegationModelChoiceExpireCommand } from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { deriveDelegatedModelChoiceRecord } from "@bigbud/shared/delegatedModelChoice";
import { Effect } from "effect";

import { withEventBase } from "./deciderHelpers.ts";
import { makeResolvedActivity } from "./deciderThreads.delegationModelChoice.logic.ts";
import { decideThreadTurnStartCommand } from "./deciderThreads.turn.start.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

type DecidedEvent = Omit<OrchestrationEvent, "sequence">;
type FallbackStart = NonNullable<ThreadDelegationModelChoiceExpireCommand["fallbackStart"]>;

export const decideDelegationModelChoiceFallbackStart = Effect.fn(
  "decideDelegationModelChoiceFallbackStart",
)(function* (input: {
  readonly command: ThreadDelegationModelChoiceExpireCommand;
  readonly fallbackStart: FallbackStart;
  readonly thread: OrchestrationThread;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<ReadonlyArray<DecidedEvent>, OrchestrationCommandInvariantError> {
  const { command, fallbackStart, thread } = input;
  const messageId = fallbackStart.prompt.messageId;
  // Already sent, or queued behind another blocker whose flush sends it exactly once.
  if (
    thread.messages.some((message) => message.id === messageId) ||
    thread.queuedPrompts?.some((prompt) => prompt.id === messageId)
  ) {
    return [];
  }
  const record = deriveDelegatedModelChoiceRecord(thread.activities);
  if (record !== null && record.choiceId !== command.choiceId) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: "This thread already has a different delegated model choice.",
    });
  }
  if (record?.status === "resolved" && record.cancelled) return [];

  const requested = fallbackStart.requested;
  const events: DecidedEvent[] = [];
  if (record === null) {
    events.push({
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      }),
      type: "thread.activity-appended",
      payload: {
        threadId: command.threadId,
        activity: makeResolvedActivity(
          {
            choiceId: command.choiceId,
            requested: requested.requested,
            fallback: requested.fallback,
            reason: requested.reason,
            used: requested.fallback,
            outcome: "fallback",
            resolvedBy: command.resolvedBy,
          },
          command.createdAt,
        ),
      },
    });
  }
  const startEvents = yield* decideThreadTurnStartCommand({
    readModel: input.readModel,
    command: {
      type: "thread.turn.start",
      commandId: command.commandId,
      threadId: command.threadId,
      message: { ...fallbackStart.prompt, role: "user", attachments: [] },
      modelSelection: requested.fallback,
      runtimeMode: fallbackStart.runtimeMode,
      interactionMode: fallbackStart.interactionMode,
      createdAt: command.createdAt,
    },
  });
  return [...events, ...startEvents];
});
