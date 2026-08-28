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

  return {
    publish: (event: OrchestrationEvent) =>
      PubSub.publish(generalWakeUp, true).pipe(Effect.andThen(deliveryHub.publish(event))),
    streamGeneral: () =>
      Stream.unwrap(
        Effect.sync(() => {
          let cursor = input.initialSequence();
          const replayPage = (): Stream.Stream<OrchestrationEvent> =>
            Stream.paginate(cursor, (pageCursor) =>
              input.readReplay(pageCursor, ORCHESTRATION_DOMAIN_EVENT_REPLAY_PAGE_SIZE).pipe(
                Effect.orDie,
                Effect.tap(() => Metric.update(orchestrationDomainEventReplayPagesTotal, 1)),
                Effect.flatMap((page) => {
                  if (page.availability === "gap") {
                    return Effect.die(new Error("orchestration domain event reactor replay gap"));
                  }
                  const lastSequence = page.events.at(-1)?.sequence;
                  if (lastSequence !== undefined) cursor = lastSequence;
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
  } as const;
});
