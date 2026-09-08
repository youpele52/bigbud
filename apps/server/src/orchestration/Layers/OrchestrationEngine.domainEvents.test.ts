import { EventId, ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { makeOrchestrationDomainEventDistribution } from "./OrchestrationEngine.domainEvents.ts";

function event(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`domain-event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe("thread-domain-event-overflow"),
    occurredAt: "2026-08-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.archived",
    payload: {
      threadId: ThreadId.makeUnsafe("thread-domain-event-overflow"),
      archivedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    },
  };
}

it.effect("uses a bounded wake-up to page canonical reactor catch-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const canonicalEvents = Array.from({ length: 1_002 }, (_, index) => event(index + 1));
      const distribution = yield* makeOrchestrationDomainEventDistribution({
        initialSequence: () => 0,
        readReplay: (fromSequenceExclusive, limit) =>
          Effect.sync(() => {
            const events = canonicalEvents
              .filter((candidate) => candidate.sequence > fromSequenceExclusive)
              .slice(0, limit);
            return {
              requestedFromSequenceExclusive: fromSequenceExclusive,
              retainedFromSequenceExclusive: 0,
              earliestAvailableSequence: canonicalEvents[0]?.sequence ?? null,
              latestSequence: canonicalEvents.at(-1)?.sequence ?? 0,
              availability: "available" as const,
              complete: events.at(-1)?.sequence === canonicalEvents.at(-1)?.sequence,
              events,
            };
          }),
      });
      const subscriber = yield* distribution
        .streamGeneral()
        .pipe(Stream.take(1_002), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* distribution.publish(canonicalEvents.at(-1)!);
      const received = Array.from(yield* Fiber.join(subscriber));

      assert.deepStrictEqual(
        received.map((nextEvent) => nextEvent.sequence),
        Array.from({ length: 1_002 }, (_, index) => index + 1),
      );
    }),
  ),
);
