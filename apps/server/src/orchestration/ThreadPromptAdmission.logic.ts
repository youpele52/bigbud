import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type {
  OrchestrationMessageReply,
  OrchestrationQueuedPrompt,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Equal, Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";

export const MAX_QUEUED_PROMPTS = 5;
export const PROMPT_QUEUE_FULL_DETAIL = "A thread can queue at most 5 prompts.";
export const PROMPT_NOT_QUEUEABLE_DETAIL =
  "This prompt cannot be queued because its bootstrap resources must be prepared before sending.";

type QueueablePromptCommand = Extract<
  OrchestrationCommand,
  { type: "thread.turn.start" | "thread.message.submit" }
>;
type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const REPLY_EXCERPT_MAX_CHARS = 240;
const TERMINAL_CONTEXT_BLOCK_REGEX = /\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*/g;

export function buildReplyExcerpt(text: string): string {
  const normalized = text.replace(TERMINAL_CONTEXT_BLOCK_REGEX, "\n").replace(/\s+/g, " ").trim();
  if (normalized.length <= REPLY_EXCERPT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, REPLY_EXCERPT_MAX_CHARS - 3).trimEnd()}...`;
}

function invariant(
  command: QueueablePromptCommand,
  detail: string,
  code?: "prompt_queue_full" | "prompt_not_queueable",
) {
  return new OrchestrationCommandInvariantError({
    commandType: command.type,
    detail,
    ...(code !== undefined ? { code } : {}),
  });
}

export type ResolvedPromptReferences = {
  readonly replyTo?: OrchestrationMessageReply;
  readonly sourceProposedPlan?: NonNullable<QueueablePromptCommand["sourceProposedPlan"]>;
};

export function resolvePromptReferences(input: {
  readonly command: QueueablePromptCommand;
  readonly readModel: OrchestrationReadModel;
  readonly targetThread: OrchestrationThread;
}): Effect.Effect<ResolvedPromptReferences, OrchestrationCommandInvariantError> {
  return Effect.gen(function* () {
    const { command, readModel, targetThread } = input;
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

    return {
      ...(replyTarget
        ? {
            replyTo: {
              messageId: replyTarget.id,
              role: replyTarget.role,
              createdAt: replyTarget.createdAt,
              excerpt: buildReplyExcerpt(replyTarget.text),
            },
          }
        : {}),
      ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
    };
  });
}

export function makeQueuedPrompt(input: {
  readonly command: QueueablePromptCommand;
  readonly readModel: OrchestrationReadModel;
  readonly targetThread: OrchestrationThread;
}): Effect.Effect<OrchestrationQueuedPrompt, OrchestrationCommandInvariantError> {
  return Effect.gen(function* () {
    const { command } = input;
    if (command.bootstrap !== undefined) {
      return yield* invariant(command, PROMPT_NOT_QUEUEABLE_DETAIL, "prompt_not_queueable");
    }
    const attachments = command.message.attachments ?? [];
    if (command.message.text.trim().length === 0 && attachments.length === 0) {
      return yield* invariant(
        command,
        "This prompt cannot be queued because it has no text or attachments.",
        "prompt_not_queueable",
      );
    }
    const references = yield* resolvePromptReferences(input);
    return {
      id: command.message.messageId,
      text: command.message.text.trim(),
      createdAt: command.createdAt,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(references.replyTo !== undefined ? { replyTo: references.replyTo } : {}),
      ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
      ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
      ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}),
      ...(command.interactionMode !== undefined
        ? { interactionMode: command.interactionMode }
        : {}),
      ...(command.bootstrapSourceThreadId !== undefined
        ? { bootstrapSourceThreadId: command.bootstrapSourceThreadId }
        : {}),
      ...(references.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: references.sourceProposedPlan }
        : {}),
    };
  });
}

export function makeQueuedPromptEvent(input: {
  readonly command: QueueablePromptCommand;
  readonly readModel: OrchestrationReadModel;
  readonly targetThread: OrchestrationThread;
  readonly queuePosition: number;
}): Effect.Effect<
  Omit<Extract<OrchestrationEvent, { type: "thread.prompt-queued" }>, "sequence">,
  OrchestrationCommandInvariantError
> {
  return makeQueuedPrompt(input).pipe(
    Effect.map((prompt) =>
      Object.assign(
        withEventBase({
          aggregateKind: "thread",
          aggregateId: input.targetThread.id,
          occurredAt: input.command.createdAt,
          commandId: input.command.commandId,
        }),
        {
          type: "thread.prompt-queued" as const,
          payload: {
            threadId: input.targetThread.id,
            prompt,
            queuePosition: input.queuePosition,
          },
        },
      ),
    ),
  );
}

export function queuedPromptMatchesCommand(
  prompt: OrchestrationQueuedPrompt,
  command: QueueablePromptCommand,
): boolean {
  return (
    prompt.id === command.message.messageId &&
    prompt.text === command.message.text.trim() &&
    Equal.equals(prompt.attachments ?? [], command.message.attachments ?? []) &&
    Equal.equals(prompt.replyTo?.messageId, command.message.replyToMessageId) &&
    Equal.equals(prompt.modelSelection, command.modelSelection) &&
    prompt.titleSeed === command.titleSeed &&
    prompt.runtimeMode === command.runtimeMode &&
    prompt.interactionMode === command.interactionMode &&
    prompt.bootstrapSourceThreadId === command.bootstrapSourceThreadId &&
    Equal.equals(prompt.sourceProposedPlan, command.sourceProposedPlan) &&
    command.bootstrap === undefined
  );
}

export function queuedPromptToTurnStartCommand(input: {
  readonly prompt: OrchestrationQueuedPrompt;
  readonly thread: OrchestrationThread;
  readonly commandId: ThreadTurnStartCommand["commandId"];
  readonly createdAt: ThreadTurnStartCommand["createdAt"];
  readonly messageId?: ThreadTurnStartCommand["message"]["messageId"];
  readonly text?: string;
}): ThreadTurnStartCommand {
  const { prompt, thread } = input;
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: thread.id,
    message: {
      messageId: input.messageId ?? prompt.id,
      role: "user",
      text: input.text ?? prompt.text,
      attachments: prompt.attachments ?? [],
      ...(prompt.replyTo !== undefined ? { replyToMessageId: prompt.replyTo.messageId } : {}),
    },
    ...(prompt.modelSelection !== undefined ? { modelSelection: prompt.modelSelection } : {}),
    ...(prompt.titleSeed !== undefined ? { titleSeed: prompt.titleSeed } : {}),
    runtimeMode: prompt.runtimeMode ?? thread.runtimeMode,
    interactionMode: prompt.interactionMode ?? thread.interactionMode,
    ...(prompt.bootstrapSourceThreadId !== undefined
      ? { bootstrapSourceThreadId: prompt.bootstrapSourceThreadId }
      : {}),
    ...(prompt.sourceProposedPlan !== undefined
      ? { sourceProposedPlan: prompt.sourceProposedPlan }
      : {}),
    createdAt: input.createdAt,
  };
}
