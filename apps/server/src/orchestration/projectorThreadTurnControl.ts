import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect } from "effect";

import { updateThread } from "./projectorHelpers.ts";

type ThreadTurnControlEvent = Extract<
  OrchestrationEvent,
  {
    readonly type:
      | "thread.turn-interrupt-requested"
      | "thread.turn-steer-requested"
      | "thread.session-stop-requested"
      | "thread.turn-control-set";
  }
>;

export function projectThreadTurnControlEvent(
  model: OrchestrationReadModel,
  event: ThreadTurnControlEvent,
): Effect.Effect<OrchestrationReadModel> {
  const thread = model.threads.find((entry) => entry.id === event.payload.threadId);
  if (!thread) return Effect.succeed(model);

  switch (event.type) {
    case "thread.turn-interrupt-requested":
      return Effect.succeed({
        ...model,
        threads: updateThread(model.threads, thread.id, {
          ...(event.payload.pendingFlushIntent !== undefined
            ? { pendingInterruptFlushIntent: event.payload.pendingFlushIntent }
            : {}),
          ...(event.payload.operation !== undefined
            ? { pendingTurnControlOperation: event.payload.operation }
            : {}),
          updatedAt: event.occurredAt,
        }),
      });

    case "thread.turn-steer-requested":
    case "thread.session-stop-requested":
      if (event.payload.operation === undefined) return Effect.succeed(model);
      return Effect.succeed({
        ...model,
        threads: updateThread(model.threads, thread.id, {
          pendingTurnControlOperation: event.payload.operation,
          ...(event.type === "thread.session-stop-requested" ? { queueHold: true } : {}),
          updatedAt: event.occurredAt,
        }),
      });

    case "thread.turn-control-set":
      return Effect.succeed({
        ...model,
        threads: updateThread(model.threads, thread.id, {
          pendingTurnControlOperation: event.payload.operation,
          updatedAt: event.occurredAt,
        }),
      });
  }
}
