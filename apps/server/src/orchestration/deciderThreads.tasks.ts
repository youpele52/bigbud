import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";

type ThreadTaskCommand = Extract<
  OrchestrationCommand,
  { type: "thread.task.upsert" | "thread.task.remove" }
>;

export const decideThreadTaskCommand = Effect.fn("decideThreadTaskCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadTaskCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<Omit<OrchestrationEvent, "sequence">, OrchestrationCommandInvariantError> {
  yield* requireThread({ readModel, command, threadId: command.threadId });
  const base = withEventBase({
    aggregateKind: "thread",
    aggregateId: command.threadId,
    occurredAt: command.createdAt,
    commandId: command.commandId,
  });
  return command.type === "thread.task.upsert"
    ? {
        ...base,
        type: "thread.task-upserted",
        payload: { threadId: command.threadId, task: command.task },
      }
    : {
        ...base,
        type: "thread.task-removed",
        payload: {
          threadId: command.threadId,
          taskId: command.taskId,
          source: command.source,
          freshness: command.freshness,
          ...(command.replacement ? { replacement: command.replacement } : {}),
        },
      };
});
