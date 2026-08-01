import {
  CommandId,
  MessageId,
  type ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { createHash } from "node:crypto";

import { resolveThreadWorkflowStatus } from "./ThreadWorkflowStatus.logic.ts";

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
  const status = resolveThreadWorkflowStatus(thread);
  if (status.isAgentActive || status.hasPendingApprovals || status.hasPendingUserInput) return null;

  const messageIds = prompts.map((prompt) => prompt.id);
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
