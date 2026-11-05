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
    command.type === "thread.approval.respond" ||
    command.type === "thread.user-input.respond" ||
    command.type === "thread.delegation.model-choice.pick" ||
    command.type === "thread.delegation.model-choice.expire" ||
    command.type === "thread.turn-control.set" ||
    command.type === "thread.queued-prompt.flush-cancel" ||
    // The provider accepted a requested turn, which clears its pending-start gate. The
    // reactor records it after any running stamp, so a still-running turn keeps blocking.
    (command.type === "thread.activity.append" &&
      [
        USER_TURN_BOUND,
        "approval.resolved",
        "user-input.resolved",
        "provider.approval.respond.failed",
        "provider.user-input.respond.failed",
        "delegation.model-choice-resolved",
      ].includes(command.activity.kind))
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
  // Each canonical revision is a new reconciled attempt. Same-state retries replay byte-for-byte.
  const attempt = `${digest}:${input.readModel.snapshotSequence ?? 0}`;
  const createdAt = thread.updatedAt ?? promptsById.get(messageIds[0]!)!.createdAt;
  return {
    type: "thread.queued-prompt.flush",
    commandId: CommandId.makeUnsafe(`${QUEUE_FLUSH_COMMAND_PREFIX}v2:${attempt}`),
    threadId: thread.id,
    messageIds,
    messageId: MessageId.makeUnsafe(`queue-message:${digest}`),
    promptVersions: messageIds.map((id) => {
      const prompt = promptsById.get(id)!;
      return { id, createdAt: prompt.createdAt, alreadySent: prompt.alreadySent === true };
    }),
    createdAt,
  };
}
