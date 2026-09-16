import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";
import {
  MAX_QUEUED_PROMPTS,
  makeQueuedPromptEvent,
  PROMPT_QUEUE_FULL_DETAIL,
  queuedPromptMatchesCommand,
  resolvePromptReferences,
} from "./ThreadPromptAdmission.logic.ts";
import { isThreadTurnDispatchBlocked } from "./ThreadDispatchSafety.logic.ts";

export function requireThreadReadyForMutation(input: {
  readonly thread: OrchestrationThread;
  readonly command: OrchestrationCommand;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.thread.deletedAt !== null) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Thread '${input.thread.id}' has already been deleted and cannot handle command '${input.command.type}'.`,
      }),
    );
  }
  if (input.thread.deletingAt !== null && input.thread.deletingAt !== undefined) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Thread '${input.thread.id}' is being deleted and cannot handle command '${input.command.type}'.`,
      }),
    );
  }
  return Effect.void;
}

type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
type ThreadActivityAppendCommand = Extract<
  OrchestrationCommand,
  { type: "thread.activity.append" }
>;

export const decideThreadTurnStartCommand = Effect.fn("decideThreadTurnStartCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadTurnStartCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  const targetThread = yield* requireThread({
    readModel,
    command,
    threadId: command.threadId,
  });
  yield* requireThreadReadyForMutation({ thread: targetThread, command });
  if (isThreadTurnDispatchBlocked(targetThread)) {
    const existing = targetThread.queuedPrompts?.find(
      (prompt) => prompt.id === command.message.messageId,
    );
    if (existing) {
      if (!queuedPromptMatchesCommand(existing, command)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This message ID is already queued with different content or settings.",
        });
      }
      return [];
    }
    const queuedEvent = yield* makeQueuedPromptEvent({
      command,
      readModel,
      targetThread,
      queuePosition: (targetThread.queuedPrompts?.length ?? 0) + 1,
    });
    if ((targetThread.queuedPrompts?.length ?? 0) >= MAX_QUEUED_PROMPTS) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: PROMPT_QUEUE_FULL_DETAIL,
        code: "prompt_queue_full",
      });
    }
    return [queuedEvent];
  }
  const references = yield* resolvePromptReferences({
    command,
    readModel,
    targetThread,
  });
  const sourceProposedPlan = references.sourceProposedPlan;
  const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    type: "thread.message-sent",
    payload: {
      threadId: command.threadId,
      messageId: command.message.messageId,
      role: "user",
      text: command.message.text,
      attachments: command.message.attachments,
      ...(references.replyTo !== undefined ? { replyTo: references.replyTo } : {}),
      turnId: null,
      streaming: false,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    },
  };
  const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    causationEventId: userMessageEvent.eventId,
    type: "thread.turn-start-requested",
    payload: {
      threadId: command.threadId,
      messageId: command.message.messageId,
      ...(references.replyTo !== undefined ? { replyTo: references.replyTo } : {}),
      ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
      ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode,
      ...(command.bootstrapSourceThreadId !== undefined
        ? { bootstrapSourceThreadId: command.bootstrapSourceThreadId }
        : {}),
      ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
      createdAt: command.createdAt,
    },
  };
  return [userMessageEvent, turnStartRequestedEvent];
});

export const decideThreadActivityAppendCommand = Effect.fn("decideThreadActivityAppendCommand")(
  function* ({
    command,
    readModel,
  }: {
    readonly command: ThreadActivityAppendCommand;
    readonly readModel: OrchestrationReadModel;
  }): Effect.fn.Return<
    Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
    OrchestrationCommandInvariantError
  > {
    const thread = yield* requireThread({
      readModel,
      command,
      threadId: command.threadId,
    });
    if (command.activity.kind !== "thread.delete.failed") {
      yield* requireThreadReadyForMutation({ thread, command });
    } else if (thread.deletedAt !== null) {
      yield* requireThreadReadyForMutation({ thread, command });
    }
    const previousActivity = thread.activities.at(-1);
    if (
      command.activity.kind === "context-window.updated" &&
      previousActivity?.kind === command.activity.kind &&
      JSON.stringify(previousActivity.payload) === JSON.stringify(command.activity.payload)
    ) {
      return [];
    }
    const requestId =
      typeof command.activity.payload === "object" &&
      command.activity.payload !== null &&
      "requestId" in command.activity.payload &&
      typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
        ? ((command.activity.payload as { requestId: string })
            .requestId as OrchestrationEvent["metadata"]["requestId"])
        : undefined;
    return {
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        ...(requestId !== undefined ? { metadata: { requestId } } : {}),
      }),
      type: "thread.activity-appended",
      payload: {
        threadId: command.threadId,
        activity: command.activity,
      },
    };
  },
);
