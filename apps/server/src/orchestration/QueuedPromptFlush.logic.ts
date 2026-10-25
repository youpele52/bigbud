import {
  CommandId,
  MessageId,
  type ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { USER_TURN_BOUND } from "@bigbud/shared/internalTextGeneration";
import { createHash } from "node:crypto";

import { compatibleQueuedPrefix, consumableQueuedPrefix } from "./QueuedPromptPolicy.logic.ts";

/** Every server-initiated queue flush (startup recovery and lifecycle) uses this command ID prefix. */
export const QUEUE_FLUSH_COMMAND_PREFIX = "queue-flush:";

/** Commands after which a thread may have become idle for queued-prompt dispatch. */
function isLifecycleFlushTrigger(command: OrchestrationCommand): boolean {
  return (
    command.type === "thread.session.set" ||
    command.type === "thread.turn.start.failed" ||
    // The provider accepted a requested turn, which clears its pending-start gate. The
    // reactor records it after any running stamp, so a still-running turn keeps blocking.
    (command.type === "thread.activity.append" && command.activity.kind === USER_TURN_BOUND)
  );
}

export function makeLifecycleQueuedPromptFlushCommand(input: {
  readonly trigger: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly createdAt: string;
}): OrchestrationCommand | null {
  if (!isLifecycleFlushTrigger(input.trigger)) return null;
  if (!("threadId" in input.trigger)) return null;
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
  const messageIds =
    thread.pendingInterruptFlushIntent?.queuedPromptIds ??
    compatibleQueuedPrefix(prompts).map((prompt) => prompt.id);
  if (consumableQueuedPrefix({ thread, messageIds }).length === 0) return null;
  // A single-prompt flush keeps the prompt's ID, so a prompt refused as busy and re-queued
  // reappears under the same ID. Its queue time and redelivery flag keep the command ID fresh.
  const promptsById = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const promptKeys = messageIds.map((id) => {
    const prompt = promptsById.get(id);
    return `${id}\t${prompt?.createdAt ?? ""}\t${prompt?.alreadySent === true ? "sent" : "new"}`;
  });
  const digest = createHash("sha256")
    .update(`${thread.id}\n${promptKeys.join("\n")}`)
    .digest("hex");
  return {
    type: "thread.queued-prompt.flush",
    commandId: CommandId.makeUnsafe(`${QUEUE_FLUSH_COMMAND_PREFIX}${digest}`),
    threadId: thread.id,
    messageIds,
    messageId: MessageId.makeUnsafe(`queue-message:${digest}`),
    createdAt: input.createdAt,
  };
}
