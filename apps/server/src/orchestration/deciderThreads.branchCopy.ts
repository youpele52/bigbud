/**
 * Decider for `thread.branch-copy.append`: one bounded batch of a server-side branch copy,
 * appended as ordinary `thread.message-sent` events on the branch. The command is internal; the
 * messages come from the server's own projection, so their recorded provenance is kept as is.
 *
 * @module deciderThreads.branchCopy
 */
import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import type { ThreadBranchCopyAppendCommand } from "@bigbud/contracts/orchestration/orchestration.branchCopy.ts";
import { Effect } from "effect";

import { requireThreadNotDeleting } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";
import type { OrchestrationCommandInvariantError } from "./Errors.ts";

export const decideThreadBranchCopyAppend = Effect.fn("decideThreadBranchCopyAppend")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadBranchCopyAppendCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  yield* requireThreadNotDeleting({ readModel, command, threadId: command.threadId });
  return command.messages.map((message) => ({
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: message.updatedAt,
      commandId: command.commandId,
    }),
    type: "thread.message-sent" as const,
    payload: {
      threadId: command.threadId,
      messageId: message.id,
      role: message.role,
      text: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
      ...(message.originSegments !== undefined ? { originSegments: message.originSegments } : {}),
      turnId: null,
      streaming: false,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    },
  }));
});
