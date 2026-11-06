import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect } from "effect";

import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";

/** Persists the thread's organization with the same rule as the in-memory projector. */
export const projectThreadOrganizationEvent = Effect.fn("projectThreadOrganizationEvent")(
  function* (input: {
    readonly event: OrchestrationEvent;
    readonly repository: ProjectionThreadRepositoryShape;
  }) {
    if (input.event.type !== "thread.organization-updated") return;
    yield* input.repository.setOrganization({
      threadId: input.event.payload.threadId,
      organization: input.event.payload.organization,
      reason: input.event.payload.reason,
      ...(input.event.payload.source ? { source: input.event.payload.source } : {}),
    });
  },
);
