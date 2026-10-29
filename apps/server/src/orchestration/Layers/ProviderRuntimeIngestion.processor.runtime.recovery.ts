import type { OrchestrationThread, ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import { isProvenSettledRecoveryTerminal } from "./ProviderRuntimeIngestion.lifecycle.ts";

/** Drop recovery redelivery only when canonical state proves the turn already settled. */
export const shouldDropSettledRecoveryTerminal = Effect.fn("shouldDropSettledRecoveryTerminal")(
  function* (event: ProviderRuntimeEvent, thread: OrchestrationThread) {
    if (!isProvenSettledRecoveryTerminal(event, thread)) return false;
    yield* Effect.logInfo("dropped recovery terminal redelivery for settled turn", {
      threadId: event.threadId,
      turnId: event.turnId,
      eventId: event.eventId,
    });
    return true;
  },
);
