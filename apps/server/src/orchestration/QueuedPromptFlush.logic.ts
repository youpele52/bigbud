import {
  CommandId,
  MessageId,
  type ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { createHash } from "node:crypto";

import { isThreadConfirmedIdleForDispatch } from "./ThreadDispatchSafety.logic.ts";

export function makeLifecycleQueuedPromptFlushCommand(input: {
  readonly trigger: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly createdAt: string;
}): OrchestrationCommand | null {
  if (
    input.trigger.type !== "thread.session.set" &&
    input.trigger.type !== "thread.turn.start.failed"
  ) {
    return null;
  }
  return makeQueuedPromptFlushCommand({
    threadId: input.trigger.threadId,
    readModel: input.readModel,
    createdAt: input.createdAt,
  });
}

export function makeQueuedPromptFlushCommand(input: {
  readonly threadId: ThreadId;
  readonly readModel: OrchestrationReadModel;
  readonly createdAt: string;
}): OrchestrationCommand | null {
  const threadId = input.threadId;
  const thread = input.readModel.threads.find((candidate) => candidate.id === threadId);
  const prompts = thread?.queuedPrompts ?? [];
  if (
    !thread ||
    prompts.length === 0 ||
    thread.archivedAt != null ||
    thread.deletingAt != null ||
    thread.deletedAt != null
  ) {
    return null;
  }
  if (!isThreadConfirmedIdleForDispatch(thread)) return null;

  const messageIds =
    thread.pendingInterruptFlushIntent?.queuedPromptIds ?? prompts.map((prompt) => prompt.id);
  const prefix = prompts.slice(0, messageIds.length);
  if (
    messageIds.length === 0 ||
    prefix.length !== messageIds.length ||
    prefix.some((prompt, index) => prompt.id !== messageIds[index])
  ) {
    return null;
  }
  const digest = createHash("sha256")
    .update(`${thread.id}\n${messageIds.join("\n")}`)
    .digest("hex");
  return {
    type: "thread.queued-prompt.flush",
    commandId: CommandId.makeUnsafe(`queue-flush:${digest}`),
    threadId: thread.id,
    messageIds,
    messageId: MessageId.makeUnsafe(`queue-message:${digest}`),
    createdAt: input.createdAt,
  };
}
