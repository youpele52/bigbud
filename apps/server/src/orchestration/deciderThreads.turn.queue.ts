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
import {
  canAutoDispatchQueuedPrompts,
  compatibleQueuedPrefix,
  consumableQueuedPrefix,
  hasActiveQueueReservation,
  queuedPrefixExecutionOptions,
  sameQueuedPromptOptions,
} from "./QueuedPromptPolicy.logic.ts";

const MAX_QUEUED_PROMPTS = 5;
type QueueCommand = Extract<
  OrchestrationCommand,
  | { type: "thread.message.submit" }
  | { type: "thread.queued-prompt.remove" }
  | { type: "thread.queued-prompt.flush" }
  | { type: "thread.queued-prompt.flush-cancel" }
>;

const queuedFollowUpText = (texts: ReadonlyArray<string>): string =>
  ["Additional instructions:", ...texts.map((text) => `- ${text.trim()}`)].join("\n");

function queueIncompatibleDetail(
  command: Extract<QueueCommand, { type: "thread.message.submit" }>,
): string | null {
  if ((command.message.attachments?.length ?? 0) > 0) {
    return "Attachments cannot be queued while a thread is busy.";
  }
  if (command.message.replyToMessageId !== undefined) {
    return "Replies cannot be queued while a thread is busy.";
  }
  if (
    command.titleSeed !== undefined ||
    command.bootstrap !== undefined ||
    command.bootstrapSourceThreadId !== undefined ||
    command.sourceProposedPlan !== undefined
  ) {
    return "This turn metadata cannot be queued while a thread is busy.";
  }
  return null;
}

function makeTurnStartCommand(
  command: Extract<QueueCommand, { type: "thread.message.submit" }>,
  thread: OrchestrationReadModel["threads"][number],
  message: Extract<OrchestrationCommand, { type: "thread.turn.start" }>["message"],
): Extract<OrchestrationCommand, { type: "thread.turn.start" }> {
  return {
    type: "thread.turn.start",
    commandId: command.commandId,
    threadId: thread.id,
    message,
    ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
    ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
    runtimeMode: command.runtimeMode ?? thread.runtimeMode,
    interactionMode: command.interactionMode ?? thread.interactionMode,
    ...(command.bootstrap !== undefined ? { bootstrap: command.bootstrap } : {}),
    ...(command.bootstrapSourceThreadId !== undefined
      ? { bootstrapSourceThreadId: command.bootstrapSourceThreadId }
      : {}),
    ...(command.sourceProposedPlan !== undefined
      ? { sourceProposedPlan: command.sourceProposedPlan }
      : {}),
    createdAt: command.createdAt,
  };
}

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
        ...(input.command.modelSelection !== undefined
          ? { modelSelection: input.command.modelSelection }
          : {}),
        ...(input.command.runtimeMode !== undefined
          ? { runtimeMode: input.command.runtimeMode }
          : {}),
        ...(input.command.interactionMode !== undefined
          ? { interactionMode: input.command.interactionMode }
          : {}),
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
      (hasActiveQueueReservation(thread) &&
        thread.pendingTurnControlOperation?.reservedPromptIds.includes(command.messageId)) ||
      thread.pendingInterruptFlushIntent?.queuedPromptIds.includes(command.messageId)
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
  const canAutoDispatch = canAutoDispatchQueuedPrompts(thread);

  if (command.type === "thread.message.submit") {
    const queuedPrompts = thread.queuedPrompts ?? [];
    const existing = queuedPrompts.find((prompt) => prompt.id === command.message.messageId);
    if (existing) {
      if (
        queueIncompatibleDetail(command) !== null ||
        existing.text !== command.message.text.trim() ||
        !sameQueuedPromptOptions(existing, command)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This message ID is already queued with different content or settings.",
        });
      }
      return [];
    }
    if (command.delivery === "auto" && canAutoDispatch && queuedPrompts.length === 0) {
      return yield* decideThreadTurnStartCommand({
        readModel,
        command: makeTurnStartCommand(command, thread, {
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments ?? [],
          ...(command.message.replyToMessageId !== undefined
            ? { replyToMessageId: command.message.replyToMessageId }
            : {}),
        }),
      });
    }
    const incompatibleDetail = queueIncompatibleDetail(command);
    if (incompatibleDetail !== null) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: incompatibleDetail,
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
    if (command.delivery !== "auto" || !canAutoDispatch) return queuedEvent;

    // Persist the suffix even when its options require a later turn.
    const prompts = compatibleQueuedPrefix([...queuedPrompts, queuedEvent.payload.prompt]);
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
          messageId: prompts[0]!.id,
          role: "user",
          text: queuedFollowUpText(prompts.map((prompt) => prompt.text)),
          attachments: [],
        },
        ...queuedPrefixExecutionOptions(thread, prompts[0]!),
        createdAt: command.createdAt,
      },
    });
    return [queuedEvent, flushedEvent, ...startEvents];
  }

  const prefix = consumableQueuedPrefix({ thread, ...command });
  if (prefix.length === 0) return [];
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
      ...queuedPrefixExecutionOptions(thread, prefix[0]!),
      createdAt: command.createdAt,
    },
  });
  return [flushedEvent, ...startEvents];
});
