import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";
import {
  decideThreadTurnStartCommand,
  requireThreadReadyForMutation,
} from "./deciderThreads.turn.start.ts";
import { isThreadConfirmedIdleForDispatch } from "./ThreadDispatchSafety.logic.ts";

const MAX_QUEUED_PROMPTS = 5;
const hasActiveReservation = (thread: OrchestrationReadModel["threads"][number]) =>
  Boolean(
    thread.pendingTurnControlOperation?.reservedPromptIds.length &&
    !["completed", "failed", "superseded", "cancelled"].includes(
      thread.pendingTurnControlOperation.state,
    ),
  );
type QueueCommand = Extract<
  OrchestrationCommand,
  | { type: "thread.message.submit" }
  | { type: "thread.queued-prompt.remove" }
  | { type: "thread.queued-prompt.flush" }
  | { type: "thread.queued-prompt.flush-cancel" }
>;

const queuedFollowUpText = (texts: ReadonlyArray<string>): string =>
  ["Additional instructions:", ...texts.map((text) => `- ${text.trim()}`)].join("\n");

function makeQueuedEvent(input: {
  readonly command: Extract<QueueCommand, { type: "thread.message.submit" }>;
  readonly threadId: ThreadId;
  readonly queuePosition: number;
}): Omit<Extract<OrchestrationEvent, { type: "thread.prompt-queued" }>, "sequence"> {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.command.createdAt,
      commandId: input.command.commandId,
    }),
    type: "thread.prompt-queued",
    payload: {
      threadId: input.threadId,
      prompt: {
        id: input.command.message.messageId,
        text: input.command.message.text.trim(),
        createdAt: input.command.createdAt,
      },
      queuePosition: input.queuePosition,
    },
  };
}

export const decideThreadQueueCommand = Effect.fn("decideThreadQueueCommand")(function* (input: {
  readonly command: QueueCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  const { command, readModel } = input;
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
  yield* requireThreadReadyForMutation({ thread, command });

  if (command.type === "thread.queued-prompt.flush-cancel") {
    if (thread.pendingInterruptFlushIntent?.intentId !== command.intentId) return [];
    return {
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      }),
      type: "thread.queued-prompt-flush-cancelled",
      payload: { threadId: thread.id, intentId: command.intentId },
    };
  }

  if (command.type === "thread.queued-prompt.remove") {
    if (
      hasActiveReservation(thread) &&
      thread.pendingTurnControlOperation?.reservedPromptIds.includes(command.messageId)
    )
      return [];
    return {
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      }),
      type: "thread.queued-prompt-removed",
      payload: { threadId: thread.id, messageId: command.messageId },
    };
  }

  if (thread.archivedAt !== null) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Thread '${thread.id}' is archived.`,
    });
  }
  const safelyIdle = isThreadConfirmedIdleForDispatch(thread);

  if (command.type === "thread.message.submit") {
    const queuedPrompts = thread.queuedPrompts ?? [];
    if (queuedPrompts.some((prompt) => prompt.id === command.message.messageId)) return [];
    if (
      command.delivery === "auto" &&
      safelyIdle &&
      !thread.queueHold &&
      queuedPrompts.length === 0
    ) {
      return yield* decideThreadTurnStartCommand({
        readModel,
        command: {
          type: "thread.turn.start",
          commandId: command.commandId,
          threadId: thread.id,
          message: {
            messageId: command.message.messageId,
            role: "user",
            text: command.message.text,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: command.createdAt,
        },
      });
    }
    if (queuedPrompts.length >= MAX_QUEUED_PROMPTS) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "A thread can queue at most 5 prompts.",
      });
    }
    const queuedEvent = makeQueuedEvent({
      command,
      threadId: thread.id,
      queuePosition: queuedPrompts.length + 1,
    });
    if (command.delivery !== "auto" || !safelyIdle || thread.queueHold) return queuedEvent;

    // The queue existed while the thread was idle. Persist the new prompt and
    // consume the exact combined prefix in this one command, preventing a
    // crash/restart window where the new auto follow-up is stranded.
    const prompts = [...queuedPrompts, queuedEvent.payload.prompt];
    const flushedEvent: Omit<OrchestrationEvent, "sequence"> = {
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      }),
      type: "thread.queued-prompts-flushed",
      payload: { threadId: thread.id, messageIds: prompts.map((prompt) => prompt.id) },
    };
    const startEvents = yield* decideThreadTurnStartCommand({
      readModel,
      command: {
        type: "thread.turn.start",
        commandId: command.commandId,
        threadId: thread.id,
        message: {
          messageId: command.message.messageId,
          role: "user",
          text: queuedFollowUpText(prompts.map((prompt) => prompt.text)),
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: command.createdAt,
      },
    });
    return [queuedEvent, flushedEvent, ...startEvents];
  }

  if (!safelyIdle && command.type === "thread.queued-prompt.flush" && !command.acknowledged)
    return [];
  if (
    hasActiveReservation(thread) &&
    thread.pendingTurnControlOperation?.operationId !== command.controlOperationId
  ) {
    return [];
  }
  const pendingIntent = thread.pendingInterruptFlushIntent;
  if (
    pendingIntent !== null &&
    pendingIntent !== undefined &&
    (pendingIntent.queuedPromptIds.length !== command.messageIds.length ||
      pendingIntent.queuedPromptIds.some((id, index) => id !== command.messageIds[index]))
  ) {
    return [];
  }
  const prefix = (thread.queuedPrompts ?? []).slice(0, command.messageIds.length);
  if (
    prefix.length !== command.messageIds.length ||
    prefix.some((prompt, index) => prompt.id !== command.messageIds[index])
  ) {
    return [];
  }
  const flushedEvent: Omit<OrchestrationEvent, "sequence"> = {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    type: "thread.queued-prompts-flushed",
    payload: { threadId: thread.id, messageIds: command.messageIds },
  };
  if (command.consumeOnly) return flushedEvent;
  const startEvents = yield* decideThreadTurnStartCommand({
    readModel,
    command: {
      type: "thread.turn.start",
      commandId: command.commandId,
      threadId: thread.id,
      message: {
        messageId: command.messageId,
        role: "user",
        text: queuedFollowUpText(prefix.map((prompt) => prompt.text)),
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: command.createdAt,
    },
  });
  return [flushedEvent, ...startEvents];
});
