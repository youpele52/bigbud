import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect, Option } from "effect";

import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";
import { mayChangePendingTurnStart, nextPendingTurnStart } from "../PendingTurnStart.logic.ts";

/** Persists the pending-start gate with the same transitions as the in-memory projector. */
export const projectThreadPendingTurnStartEvent = Effect.fn("projectThreadPendingTurnStartEvent")(
  function* (input: {
    readonly event: OrchestrationEvent;
    readonly repository: ProjectionThreadRepositoryShape;
  }) {
    const { event, repository } = input;
    // thread.created writes its own row with an empty gate; most events cannot move the gate.
    if (event.type === "thread.created" || !mayChangePendingTurnStart(event)) return;
    if (!("threadId" in event.payload)) return;
    const existing = yield* repository.getById({ threadId: event.payload.threadId });
    if (Option.isNone(existing)) return;
    const current = existing.value.pendingTurnStart ?? null;
    const next = nextPendingTurnStart(current, event);
    if (next === undefined || next === current) return;
    yield* repository.upsert({ ...existing.value, pendingTurnStart: next });
  },
);
