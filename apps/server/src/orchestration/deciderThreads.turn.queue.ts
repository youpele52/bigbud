import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationQueuedPrompt,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { requireThreadAttachmentsSupported } from "./ThreadAttachmentAdmission.ts";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { nowIso, withEventBase } from "./deciderHelpers.ts";
import {
  decideThreadTurnStartCommand,
  requireThreadReadyForMutation,
} from "./deciderThreads.turn.start.ts";
import {
  canAutoDispatchQueuedPrompts,
  compatibleQueuedPrefix,
  consumableQueuedPrefix,
  countedQueuedPrompts,
  hasActiveQueueReservation,
  redeliveryQueuePosition,
  userReleasesStalePendingTurnStart,
} from "./QueuedPromptPolicy.logic.ts";
import {
  isSentMessageRedelivery,
  MAX_QUEUED_PROMPTS,
  makeQueuedPromptEvent,
  PROMPT_QUEUE_FULL_DETAIL,
  queuedPromptMatchesCommand,
  queuedPromptToTurnStartCommand,
} from "./ThreadPromptAdmission.logic.ts";

type QueueCommand = Extract<
  OrchestrationCommand,
  | { type: "thread.message.submit" }
  | { type: "thread.queued-prompt.remove" }
  | { type: "thread.queued-prompt.flush" }
  | { type: "thread.queued-prompt.flush-cancel" }
>;

const queuedFollowUpText = (texts: ReadonlyArray<string>): string =>
  ["Additional instructions:", ...texts.map((text) => `- ${text.trim()}`)].join("\n");

export function attributedSegments(prompt: OrchestrationQueuedPrompt) {
  return (
    prompt.originSegments ?? [
      {
        kind: "ordinaryUser" as const,
        actor: "user" as const,
        text: prompt.text,
        sourceThreads: [],
        verified: true,
      },
    ]
  );
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

type QueuedPrompt = NonNullable<OrchestrationReadModel["threads"][number]["queuedPrompts"]>[number];
type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

/** One flushed prompt keeps its own ID and text; several become one follow-up message. */
function buildQueuedFlushTurnStart(input: {
  readonly prompt: QueuedPrompt;
  readonly thread: OrchestrationReadModel["threads"][number];
  readonly commandId: ThreadTurnStartCommand["commandId"];
  readonly createdAt: string;
  readonly messageId?: ThreadTurnStartCommand["message"]["messageId"];
  readonly prompts: ReadonlyArray<QueuedPrompt>;
}) {
  return queuedPromptToTurnStartCommand({
    prompt: input.prompt,
    thread: input.thread,
    commandId: input.commandId,
    createdAt: input.createdAt,
    ...(input.prompts.length <= 1
      ? {}
      : {
          messageId: input.messageId ?? input.prompt.id,
          text: queuedFollowUpText(input.prompts.map((prompt) => prompt.text)),
          originSegments: input.prompts.flatMap(attributedSegments),
        }),
  });
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
  if (command.type === "thread.message.submit")
    yield* requireThreadAttachmentsSupported(thread, command);

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
    ) {
      return [];
    }
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
      if (!queuedPromptMatchesCommand(existing, command)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This message ID is already queued with different content or settings.",
        });
      }
      return [];
    }
    const sentMessage = thread.messages.find((message) => message.id === command.message.messageId);
    const redelivery = isSentMessageRedelivery(command);
    // A message already in the transcript is only re-queued by the server's busy recovery.
    if (sentMessage && !redelivery) return [];
    if (redelivery && sentMessage?.role !== "user") {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Only a user message already in the thread can be redelivered.",
      });
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
          ...(command.originSegments !== undefined
            ? { originSegments: command.originSegments }
            : {}),
        }),
      });
    }
    const queuedEvent = yield* makeQueuedPromptEvent({
      command,
      readModel,
      targetThread: thread,
      queuePosition: redelivery ? redeliveryQueuePosition(thread) : queuedPrompts.length + 1,
    });
    if (!redelivery && countedQueuedPrompts(queuedPrompts) >= MAX_QUEUED_PROMPTS) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: PROMPT_QUEUE_FULL_DETAIL,
        code: "prompt_queue_full",
      });
    }
    if (command.delivery !== "auto" || !canAutoDispatch) return queuedEvent;

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
      command: buildQueuedFlushTurnStart({
        prompt: prompts[0]!,
        thread,
        commandId: command.commandId,
        createdAt: command.createdAt,
        prompts,
      }),
    });
    return [queuedEvent, flushedEvent, ...startEvents];
  }

  // The pending start's `requestedAt` is server time, so the user's release is judged by it too.
  const releasedAt = nowIso();
  const prefix = consumableQueuedPrefix({ thread, ...command, releasedAt });
  if (prefix.length === 0) return [];
  const flushedEvent: Omit<OrchestrationEvent, "sequence"> = {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    type: "thread.queued-prompts-flushed",
    payload: { threadId: thread.id, messageIds: prefix.map((prompt) => prompt.id) },
  };
  if (command.consumeOnly) return flushedEvent;
  const startEvents = yield* decideThreadTurnStartCommand({
    // "Send now" past a stale pending start replaces that start with this one.
    readModel: userReleasesStalePendingTurnStart({ thread, ...command, releasedAt })
      ? {
          ...readModel,
          threads: readModel.threads.map((entry) =>
            entry.id === thread.id ? { ...entry, pendingTurnStart: null } : entry,
          ),
        }
      : readModel,
    command: buildQueuedFlushTurnStart({
      prompt: prefix[0]!,
      thread,
      commandId: command.commandId,
      createdAt: command.createdAt,
      messageId: command.messageId,
      prompts: prefix,
    }),
  });
  return [flushedEvent, ...startEvents];
});
