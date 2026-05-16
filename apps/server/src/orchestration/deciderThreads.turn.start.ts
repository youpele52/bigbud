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

const REPLY_EXCERPT_MAX_CHARS = 240;
const TERMINAL_CONTEXT_BLOCK_REGEX = /\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*/g;

function buildReplyExcerpt(text: string): string {
  const normalized = text.replace(TERMINAL_CONTEXT_BLOCK_REGEX, "\n").replace(/\s+/g, " ").trim();
  if (normalized.length <= REPLY_EXCERPT_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, REPLY_EXCERPT_MAX_CHARS - 3).trimEnd()}...`;
}

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
  const sourceProposedPlan = command.sourceProposedPlan;
  const sourceThread = sourceProposedPlan
    ? yield* requireThread({
        readModel,
        command,
        threadId: sourceProposedPlan.threadId,
      })
    : null;
  const sourcePlan =
    sourceProposedPlan && sourceThread
      ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
      : null;
  if (sourceProposedPlan && !sourcePlan) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
    });
  }
  if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
    });
  }
  const replyToMessageId = command.message.replyToMessageId;
  const replyTarget =
    replyToMessageId !== undefined
      ? (targetThread.messages.find((entry) => entry.id === replyToMessageId) ?? null)
      : null;
  if (replyToMessageId !== undefined && !replyTarget) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Reply target message '${replyToMessageId}' does not exist on thread '${targetThread.id}'.`,
    });
  }
  if (replyTarget?.role === "system") {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Reply target message '${replyToMessageId}' cannot reference a system message.`,
    });
  }
  if (replyTarget?.streaming) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Reply target message '${replyToMessageId}' is still streaming and cannot be referenced yet.`,
    });
  }
  const replyTo =
    replyTarget !== null
      ? {
          messageId: replyTarget.id,
          role: replyTarget.role,
          createdAt: replyTarget.createdAt,
          excerpt: buildReplyExcerpt(replyTarget.text),
        }
      : undefined;
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
      ...(replyTo !== undefined ? { replyTo } : {}),
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
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
      ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
      runtimeMode: targetThread.runtimeMode,
      interactionMode: targetThread.interactionMode,
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
  }): Effect.fn.Return<Omit<OrchestrationEvent, "sequence">, OrchestrationCommandInvariantError> {
    yield* requireThread({
      readModel,
      command,
      threadId: command.threadId,
    });
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
