/**
 * Decider for the delegated model choice (thread orchestration Goal 11). `hold` queues the
 * delegated first message and records an approval-style pending choice atomically; `pick` and
 * `expire` resolve it (first resolution wins), switch the tributary's model and start the held
 * message through the ordinary turn-start decision.
 *
 * @module deciderThreads.delegationModelChoice
 */
import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThreadActivity,
} from "@bigbud/contracts";
import {
  DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND,
  type DelegationModelChoiceResolved,
  type ThreadDelegationModelChoiceExpireCommand,
  type ThreadDelegationModelChoiceHoldCommand,
  type ThreadDelegationModelChoicePickCommand,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import {
  deriveDelegatedModelChoiceRecord,
  derivePendingDelegatedModelChoice,
} from "@bigbud/shared/delegatedModelChoice";
import { Effect } from "effect";

import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";
import { decideDelegationModelChoiceFallbackStart } from "./deciderThreads.delegationModelChoice.fallback.ts";
import {
  findOfferedOption,
  makeResolvedActivity,
  resolvedReadModel,
} from "./deciderThreads.delegationModelChoice.logic.ts";
import {
  decideThreadTurnStartCommand,
  requireThreadReadyForMutation,
} from "./deciderThreads.turn.start.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { isThreadTurnDispatchBlocked } from "./ThreadDispatchSafety.logic.ts";
import {
  makeQueuedPromptEvent,
  queuedPromptToTurnStartCommand,
} from "./ThreadPromptAdmission.logic.ts";

type DecidedEvent = Omit<OrchestrationEvent, "sequence">;
export type DelegationModelChoiceCommand =
  | ThreadDelegationModelChoiceHoldCommand
  | ThreadDelegationModelChoiceExpireCommand
  | ThreadDelegationModelChoicePickCommand;

const eventBase = (command: DelegationModelChoiceCommand) =>
  withEventBase({
    aggregateKind: "thread",
    aggregateId: command.threadId,
    occurredAt: command.createdAt,
    commandId: command.commandId,
  });

const decideHold = Effect.fn("decideDelegationModelChoiceHold")(function* (
  command: ThreadDelegationModelChoiceHoldCommand,
  readModel: OrchestrationReadModel,
): Effect.fn.Return<ReadonlyArray<DecidedEvent>, OrchestrationCommandInvariantError> {
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
  yield* requireThreadReadyForMutation({ thread, command });
  const choiceId = command.requestedActivity.payload.choiceId;
  const existing = deriveDelegatedModelChoiceRecord(thread.activities);
  if (existing?.choiceId === choiceId) {
    // The hold ran (its requested activity exists): the held message is queued, sent, or was
    // deliberately cancelled, so a retry is a no-op. A resolution without a hold comes from the
    // hold-failure fallback, which is done only once its turn started with this message (M2).
    const held = thread.activities.some((activity) => activity.id === command.requestedActivity.id);
    const sent = thread.messages.some((message) => message.id === command.prompt.messageId);
    if (held || sent || (existing.status === "resolved" && existing.cancelled)) return [];
    // A retry after a failed fallback start must continue the fallback, not report success.
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: "The delegated model choice was resolved but no delegated message was sent.",
    });
  }
  if (thread.latestTurn !== null || existing !== null) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: "A delegated model choice can only hold a thread's first turn.",
    });
  }
  const activity: OrchestrationThreadActivity = {
    id: command.requestedActivity.id,
    tone: "info",
    kind: DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND,
    summary: command.requestedActivity.summary,
    payload: command.requestedActivity.payload,
    turnId: null,
    createdAt: command.createdAt,
  };
  const queued = yield* makeQueuedPromptEvent({
    command: {
      type: "thread.turn.start",
      commandId: command.commandId,
      threadId: command.threadId,
      message: { ...command.prompt, role: "user", attachments: [] },
      modelSelection: command.requestedActivity.payload.fallback,
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode,
      createdAt: command.createdAt,
    },
    readModel,
    targetThread: thread,
    queuePosition: (thread.queuedPrompts?.length ?? 0) + 1,
  });
  const appended: DecidedEvent = {
    ...eventBase(command),
    type: "thread.activity-appended",
    payload: { threadId: command.threadId, activity },
  };
  return [appended, queued];
});

const decideResolution = Effect.fn("decideDelegationModelChoiceResolution")(function* (
  command: ThreadDelegationModelChoiceExpireCommand | ThreadDelegationModelChoicePickCommand,
  readModel: OrchestrationReadModel,
): Effect.fn.Return<ReadonlyArray<DecidedEvent>, OrchestrationCommandInvariantError> {
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
  yield* requireThreadReadyForMutation({ thread, command });
  const pending = derivePendingDelegatedModelChoice(thread.activities);
  if (pending === null || pending.choiceId !== command.choiceId) {
    // The hold-failure fallback starts the message itself when no hold is pending (review #2).
    return command.type === "thread.delegation.model-choice.expire" &&
      command.fallbackStart !== undefined
      ? yield* decideDelegationModelChoiceFallbackStart({
          command,
          fallbackStart: command.fallbackStart,
          thread,
          readModel,
        })
      : [];
  }

  const picked =
    command.type === "thread.delegation.model-choice.pick"
      ? findOfferedOption(pending, command.modelSelection)
      : undefined;
  if (command.type === "thread.delegation.model-choice.pick" && picked === undefined) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: "The chosen model was not offered for this delegated thread.",
    });
  }
  const held = thread.queuedPrompts?.find((prompt) => prompt.id === pending.heldMessageId);
  const cancelled = thread.archivedAt !== null || held === undefined;
  const used = picked?.selection ?? pending.fallback;
  const payload: DelegationModelChoiceResolved = {
    choiceId: pending.choiceId,
    requested: pending.requested,
    fallback: pending.fallback,
    reason: pending.reason,
    used,
    outcome: picked === undefined || picked.isFallback ? "fallback" : "user-picked",
    resolvedBy:
      command.type === "thread.delegation.model-choice.pick" ? "user" : command.resolvedBy,
    ...(cancelled ? { cancelled: true } : {}),
  };
  const activity = makeResolvedActivity(payload, command.createdAt);
  const events: DecidedEvent[] = [
    {
      ...eventBase(command),
      type: "thread.activity-appended",
      payload: { threadId: thread.id, activity },
    },
    {
      ...eventBase(command),
      type: "thread.meta-updated",
      payload: { threadId: thread.id, modelSelection: used, updatedAt: command.createdAt },
    },
  ];
  if (cancelled || held === undefined) return events;

  const resolved = resolvedReadModel({
    readModel,
    thread,
    activity,
    used,
    heldMessageId: held.id,
  });
  // Another blocker (e.g. a starting session) keeps the message queued for the lifecycle flush.
  if (isThreadTurnDispatchBlocked(resolved.thread)) return events;
  const startEvents = yield* decideThreadTurnStartCommand({
    readModel: resolved.readModel,
    command: {
      ...queuedPromptToTurnStartCommand({
        prompt: held,
        thread: resolved.thread,
        commandId: command.commandId,
        createdAt: command.createdAt,
      }),
      modelSelection: used,
    },
  });
  events.push(
    {
      ...eventBase(command),
      type: "thread.queued-prompts-flushed",
      payload: { threadId: thread.id, messageIds: [held.id] },
    },
    ...startEvents,
  );
  return events;
});

export const decideDelegationModelChoiceCommand = Effect.fn("decideDelegationModelChoiceCommand")(
  function* ({
    command,
    readModel,
  }: {
    readonly command: DelegationModelChoiceCommand;
    readonly readModel: OrchestrationReadModel;
  }): Effect.fn.Return<ReadonlyArray<DecidedEvent>, OrchestrationCommandInvariantError> {
    return command.type === "thread.delegation.model-choice.hold"
      ? yield* decideHold(command, readModel)
      : yield* decideResolution(command, readModel);
  },
);
