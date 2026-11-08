import type { OrchestrationEvent, OrchestrationReplayEventsResult } from "@bigbud/contracts";
import { Effect, Metric, Option, PubSub, Stream } from "effect";

import { orchestrationDomainEventReplayPagesTotal } from "../../observability/Metrics.orchestrationRecovery.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import { makeOrchestrationDeliveryHub } from "./OrchestrationEngine.deliveryHub.ts";

export const ORCHESTRATION_DOMAIN_EVENT_REPLAY_PAGE_SIZE = 500;

export const makeOrchestrationDomainEventDistribution = Effect.fn(
  "makeOrchestrationDomainEventDistribution",
)(function* (input: {
  readonly initialSequence: () => number;
  readonly readReplay: (
    fromSequenceExclusive: number,
    limit: number,
  ) => Effect.Effect<OrchestrationReplayEventsResult, OrchestrationEventStoreError>;
}) {
  const generalWakeUp = yield* PubSub.sliding<boolean>({ capacity: 1, replay: 1 });
  const deliveryHub = yield* makeOrchestrationDeliveryHub;
  // Read cursors of open reactor streams. Event-log maintenance must keep every event after
  // the lowest one: a reactor stream dies when its next replay page is a gap.
  const openCursors = new Set<{ sequence: number }>();

  return {
    publish: (event: OrchestrationEvent) =>
      PubSub.publish(generalWakeUp, true).pipe(Effect.andThen(deliveryHub.publish(event))),
    streamGeneral: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const opened = { sequence: input.initialSequence() };
              openCursors.add(opened);
              return opened;
            }),
            (opened) => Effect.sync(() => openCursors.delete(opened)),
          );
          const replayPage = (): Stream.Stream<OrchestrationEvent> =>
            Stream.paginate(cursor.sequence, (pageCursor) =>
              input.readReplay(pageCursor, ORCHESTRATION_DOMAIN_EVENT_REPLAY_PAGE_SIZE).pipe(
                Effect.orDie,
                Effect.tap(() => Metric.update(orchestrationDomainEventReplayPagesTotal, 1)),
                Effect.flatMap((page) => {
                  if (page.availability === "gap") {
                    return Effect.die(new Error("orchestration domain event reactor replay gap"));
                  }
                  const lastSequence = page.events.at(-1)?.sequence;
                  if (lastSequence !== undefined) cursor.sequence = lastSequence;
                  const nextCursor =
                    !page.complete && lastSequence !== undefined && lastSequence > pageCursor
                      ? Option.some(lastSequence)
                      : Option.none<number>();
                  return Effect.succeed([page.events, nextCursor] as const);
                }),
              ),
            );
          return Stream.fromPubSub(generalWakeUp).pipe(Stream.flatMap(replayPage));
        }),
      ),
    openDeliveryCapture: deliveryHub.openCapture,
    /** Lowest read cursor of an open reactor stream; null while none is open. */
    oldestOpenCursor: (): number | null => {
      let oldest: number | null = null;
      for (const cursor of openCursors) {
        oldest = oldest === null ? cursor.sequence : Math.min(oldest, cursor.sequence);
      }
      return oldest;
    },
  } as const;
});
