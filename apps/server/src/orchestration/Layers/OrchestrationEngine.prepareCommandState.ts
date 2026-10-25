import type { OrchestrationCommand, OrchestrationThread, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { forkLineageThreadIds } from "../deciderThreads.fork.logic.ts";
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
    if (command.type === "thread.fork") {
      // The fork copies settled history from its source, so the source needs full history.
      return Effect.gen(function* () {
        yield* input.threadStateHydrator!.load(command.threadId, "operational");
        const source = yield* input.threadStateHydrator!.load(command.sourceThreadId, "history");
        // Earlier forks decide idempotency only while they still exist (deleted ones do not).
        for (const forkThreadId of new Set(source ? forkLineageThreadIds(source) : [])) {
          if (forkThreadId !== command.threadId) {
            yield* input.threadStateHydrator!.load(forkThreadId, "operational");
          }
        }
      });
    }
    const aggregate = commandToAggregateRef(command);
    if (aggregate.aggregateKind !== "thread") return Effect.void;
    const targetThreadId = aggregate.aggregateId as ThreadId;
    const sourceThreadId =
      command.type === "thread.turn.start" || command.type === "thread.message.submit"
        ? command.sourceProposedPlan?.threadId
        : undefined;
    const historyRequired =
      (command.type === "thread.meta.update" && command.title !== undefined) ||
      command.type === "thread.turn.start" ||
      (command.type === "thread.message.submit" &&
        command.message.replyToMessageId !== undefined) ||
      sourceThreadId === targetThreadId ||
      command.type === "thread.checkpoint.revert" ||
      command.type === "thread.revert.complete" ||
      // The startup window omits idle threads' activities; a held choice must be visible.
      command.type === "thread.delegation.model-choice.hold" ||
      command.type === "thread.delegation.model-choice.expire" ||
      command.type === "thread.delegation.model-choice.pick";
    return Effect.gen(function* () {
      yield* input.threadStateHydrator!.load(
        targetThreadId,
        historyRequired ? "history" : "operational",
      );
      if (sourceThreadId !== undefined && sourceThreadId !== targetThreadId) {
        yield* input.threadStateHydrator!.load(sourceThreadId, "history");
      }
    });
  };
}
