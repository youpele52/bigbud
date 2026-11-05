import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationTurnControlOperation,
} from "@bigbud/contracts";
import { createHash } from "node:crypto";
import { consumableQueuedPrefix, samePromptIds } from "./QueuedPromptPolicy.logic.ts";

/** Live acknowledgement and restart recovery reconstruct the same immutable owned attempt. */
export function makeReservedQueuedPromptFlushCommand(input: {
  thread: OrchestrationThread;
  operation: OrchestrationTurnControlOperation;
  consumeOnly?: boolean;
  revision: number;
}): Extract<OrchestrationCommand, { type: "thread.queued-prompt.flush" }> | null {
  const { thread } = input;
  const operation = thread.pendingTurnControlOperation;
  if (
    !operation ||
    operation.operationId !== input.operation.operationId ||
    operation.sessionEpoch !== input.operation.sessionEpoch ||
    !samePromptIds(operation.reservedPromptIds, input.operation.reservedPromptIds)
  )
    return null;
  const prompts = consumableQueuedPrefix({
    thread,
    messageIds: operation.reservedPromptIds,
    controlOperationId: operation.operationId,
    consumeOnly: input.consumeOnly,
  });
  if (prompts.length === 0) return null;
  const promptVersions = prompts.map(({ id, createdAt, alreadySent }) => ({
    id,
    createdAt,
    alreadySent: alreadySent === true,
  }));
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        promptVersions,
        revision: input.revision,
        operation,
        session: thread.session,
        consumeOnly: input.consumeOnly === true,
      }),
    )
    .digest("hex");
  return {
    type: "thread.queued-prompt.flush",
    commandId: CommandId.makeUnsafe(`queue-flush:control-v2:${identity}`),
    threadId: thread.id,
    messageIds: operation.reservedPromptIds,
    messageId: MessageId.makeUnsafe(`turn-control:${operation.operationId}`),
    promptVersions,
    acknowledged: true,
    ...(input.consumeOnly ? { consumeOnly: true } : {}),
    controlOperationId: operation.operationId,
    createdAt: operation.updatedAt,
  };
}
