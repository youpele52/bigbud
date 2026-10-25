import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect } from "effect";

import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";

/** Persists the thread's recovery notice with the same rule as the in-memory projector. */
export const projectThreadRecoveryEvent = Effect.fn("projectThreadRecoveryEvent")(
  function* (input: {
    readonly event: OrchestrationEvent;
    readonly repository: ProjectionThreadRepositoryShape;
  }) {
    if (input.event.type !== "thread.recovery-updated") return;
    yield* input.repository.setRecovery({
      threadId: input.event.payload.threadId,
      recovery: input.event.payload.recovery,
    });
  },
);
