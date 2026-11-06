import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { OrganizationResync } from "./organizationLifecycle.ts";
import {
  type OrganizationObservation,
  organizationObservationIds,
  organizationObservationUrgent,
} from "./organizationObservation.ts";

/** Capture only marks thread IDs dirty; observation re-reads current state, so coalescing is
 * lossless. A capture overflow (which ends the stream with a defect) or an unexpected end is a
 * routine resync: the next attempt opens a fresh capture before its snapshot.
 */
export function consumeOrganizationCapture<E>(input: {
  stream: Stream.Stream<OrchestrationEvent, E>;
  isOverflowed: Effect.Effect<boolean>;
  observations: OrganizationObservation;
  /** Captured deletion forgets terminal barriers for the whole subtree. */
  forget?: (threadId: string) => Effect.Effect<void>;
  /** Post-commit deliberate organisation updates (manual moves, Undo) may move the barrier. */
  onDeliberateOrganization?: () => void;
}): Effect.Effect<void, Error> {
  return Stream.runForEach(input.stream, (event) =>
    Effect.gen(function* () {
      const ids = organizationObservationIds(event);
      if (event.type === "thread.deleted" && input.forget)
        for (const id of ids) yield* input.forget(id);
      if (event.type === "thread.organization-updated" && !event.payload.automaticMove)
        input.onDeliberateOrganization?.();
      const urgent = organizationObservationUrgent(event);
      for (const id of ids) input.observations.mark(id, urgent);
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (yield* input.isOverflowed)
          return yield* Effect.fail(new OrganizationResync("organisation capture overflow"));
        const error = Cause.squash(cause);
        return yield* Effect.fail(
          error instanceof Error ? error : new Error("organisation capture failed"),
        );
      }),
    ),
    Effect.andThen(Effect.fail(new OrganizationResync("organisation capture ended"))),
  );
}
