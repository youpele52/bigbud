import { CommandId, type MessageId, type ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";

import { sanitizeElevatorSummary } from "../git/Utils.ts";
import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { countVisibleSummaryMessages } from "../orchestration/Layers/ThreadMetadataGeneration.summaryInput.ts";
import { stableThreadToolId } from "./ThreadOrchestrationTools.origins.ts";

/** The authenticated caller is the only writable thread. Never accept a target identifier. */
export const setElevatorSummaryViaOrchestration = Effect.fn("setElevatorSummaryViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadId: ThreadId;
    readonly summary: string;
    readonly invocationId: string;
    readonly sourceMessageId: MessageId;
  }) {
    const summary = sanitizeElevatorSummary(input.summary);
    if (!summary) return yield* Effect.fail(new Error("Thread summary cannot be empty."));
    if (!input.invocationId.trim() || !input.sourceMessageId.trim())
      return yield* Effect.fail(new Error("invocationId and sourceMessageId are required."));
    const thread = yield* ensureOrchestrationThreadState(
      input.orchestrationEngine,
      input.threadId,
      "history",
    );
    if (!thread || thread.deletedAt !== null)
      return yield* Effect.fail(new Error("Caller thread was not found."));
    if (thread.deletingAt) return yield* Effect.fail(new Error("Caller thread is being deleted."));
    const commandId = CommandId.makeUnsafe(
      stableThreadToolId(
        "command",
        JSON.stringify([
          input.threadId,
          input.sourceMessageId,
          input.invocationId,
          "set_elevator_summary",
        ]),
      ),
    );
    // Reuse the original frontier after a lost response, even if more messages have arrived.
    // Changed material must still reach canonical command-payload conflict protection.
    const receipts = input.orchestrationEngine.readEventsByCommandId
      ? yield* input.orchestrationEngine.readEventsByCommandId(commandId)
      : [];
    const committed = receipts.find(
      (event) =>
        event.type === "thread.meta-updated" &&
        event.commandId === commandId &&
        event.payload.threadId === input.threadId,
    );
    if (committed?.type === "thread.meta-updated" && committed.payload.elevatorSummary === summary)
      return { summary, threadId: input.threadId, commandId };
    const elevatorSummaryMessageCount =
      committed?.type === "thread.meta-updated"
        ? committed.payload.elevatorSummaryMessageCount
        : Math.max(
            thread.elevatorSummaryMessageCount,
            countVisibleSummaryMessages(thread.messages),
          );
    yield* input.orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId,
      threadId: input.threadId,
      elevatorSummary: summary,
      ...(elevatorSummaryMessageCount !== undefined ? { elevatorSummaryMessageCount } : {}),
    });
    // Canonical metadata hooks advance the summary revision in the event transaction,
    // fencing every already-captured automatic result without touching provider sessions.
    return { summary, threadId: input.threadId, commandId };
  },
);
