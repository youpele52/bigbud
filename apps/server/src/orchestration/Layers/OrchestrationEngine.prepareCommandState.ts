import type { OrchestrationCommand, OrchestrationThread, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { commandToAggregateRef } from "./OrchestrationEngine.commandProcessing.ts";

type ThreadStateHydrator<HydrationError> = {
  readonly load: (
    threadId: ThreadId,
    level: "operational" | "history",
  ) => Effect.Effect<OrchestrationThread | undefined, HydrationError>;
};

export function makePrepareCommandState<HydrationError>(input: {
  readonly threadStateHydrator: ThreadStateHydrator<HydrationError> | null;
}) {
  return (command: OrchestrationCommand) => {
    if (input.threadStateHydrator === null) return Effect.void;
    if (command.type === "thread.create") {
      return Effect.gen(function* () {
        yield* input.threadStateHydrator!.load(command.threadId, "operational");
        if (
          command.parentThread !== undefined &&
          command.parentThread.threadId !== command.threadId
        ) {
          yield* input.threadStateHydrator!.load(command.parentThread.threadId, "operational");
        }
      });
    }
    const aggregate = commandToAggregateRef(command);
    if (aggregate.aggregateKind !== "thread") return Effect.void;
    const historyRequired =
      command.type === "thread.turn.start" ||
      command.type === "thread.checkpoint.revert" ||
      command.type === "thread.revert.complete";
    return Effect.gen(function* () {
      yield* input.threadStateHydrator!.load(
        aggregate.aggregateId as ThreadId,
        historyRequired ? "history" : "operational",
      );
      if (command.type === "thread.turn.start" && command.sourceProposedPlan) {
        yield* input.threadStateHydrator!.load(command.sourceProposedPlan.threadId, "history");
      }
    });
  };
}
