import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect } from "effect";

import { QUEUE_FLUSH_COMMAND_PREFIX } from "../QueuedPromptFlush.logic.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

type TurnStartRequestedEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

/**
 * Startup work commits turn starts before this reactor subscribes: the engine's queue recovery
 * flush, and lifecycle flushes after ingestion's startup reconciliation. The subscription starts
 * at the snapshot it opens on, so those events would never reach the reactor and their gates
 * would hold the queue forever. After subscribing, re-drive every pending start this process
 * committed by a server queue flush; turn-start handling is deduplicated by command, so one
 * the stream also delivers runs once. A client's own turn start is never resent here, and gates
 * from before this process started are the engine's to settle, not resend.
 */
export const recoverUnhandledTurnStarts = Effect.fn("recoverUnhandledTurnStarts")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly process: (event: TurnStartRequestedEvent) => Effect.Effect<void>;
  }) {
    const { orchestrationEngine } = input;
    const startupSequence = orchestrationEngine.startupSequence;
    if (startupSequence === undefined) return;
    const readModel = yield* orchestrationEngine.getReadModel();
    for (const thread of readModel.threads) {
      const pending = thread.pendingTurnStart;
      const sequence = pending?.requestedSequence;
      if (!pending || sequence === undefined || sequence <= startupSequence) continue;
      if (thread.deletedAt != null) continue;
      const page = yield* orchestrationEngine.readReplay(sequence - 1, 1);
      const event = page.events[0];
      if (
        event?.type !== "thread.turn-start-requested" ||
        event.sequence !== sequence ||
        event.payload.messageId !== pending.messageId ||
        !event.commandId?.startsWith(QUEUE_FLUSH_COMMAND_PREFIX)
      )
        continue;
      yield* Effect.logInfo("re-driving a turn start committed before the reactor subscribed", {
        threadId: thread.id,
        messageId: pending.messageId,
        sequence,
      });
      yield* input.process(event);
    }
  },
);
