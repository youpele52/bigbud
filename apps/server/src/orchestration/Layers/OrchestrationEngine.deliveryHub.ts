import type { OrchestrationEvent } from "@bigbud/contracts";
import { Deferred, Effect, Queue, Stream } from "effect";

export const ORCHESTRATION_DELIVERY_LIVE_CAPTURE_CAPACITY = 2_000;

type Capture = {
  readonly events: Queue.Queue<OrchestrationEvent>;
  readonly overflowed: Deferred.Deferred<void>;
};

export const makeOrchestrationDeliveryHub = Effect.sync(() => {
  const captures = new Set<Capture>();

  const closeCapture = (capture: Capture) =>
    Effect.sync(() => captures.delete(capture)).pipe(
      Effect.andThen(Queue.shutdown(capture.events)),
    );

  const openCapture = (capacity = ORCHESTRATION_DELIVERY_LIVE_CAPTURE_CAPACITY) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const capture = {
          events: yield* Queue.dropping<OrchestrationEvent>(capacity),
          overflowed: yield* Deferred.make<void>(),
        };
        captures.add(capture);
        return capture;
      }),
      closeCapture,
    ).pipe(
      Effect.map((capture) =>
        Stream.merge(
          Stream.fromQueue(capture.events),
          Stream.fromEffect(
            Deferred.await(capture.overflowed).pipe(
              Effect.andThen(
                Effect.die(new Error("orchestration delivery live capture overflowed")),
              ),
            ),
          ),
        ),
      ),
    );

  const publish = (event: OrchestrationEvent) =>
    Effect.forEach(
      Array.from(captures),
      (capture) =>
        Queue.offer(capture.events, event).pipe(
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.void
              : Effect.sync(() => captures.delete(capture)).pipe(
                  Effect.andThen(Deferred.succeed(capture.overflowed, undefined)),
                  Effect.andThen(Queue.shutdown(capture.events)),
                ),
          ),
        ),
      { discard: true },
    );

  return { openCapture, publish } as const;
});
