import type { OrchestrationEvent } from "@bigbud/contracts";
import { Deferred, Effect, Queue, Ref, Stream } from "effect";

export const ORCHESTRATION_DELIVERY_LIVE_CAPTURE_CAPACITY = 2_000;

type Capture = {
  readonly events: Queue.Queue<OrchestrationEvent>;
  readonly overflowed: Deferred.Deferred<void>;
  readonly overflowState: Ref.Ref<boolean>;
  readonly queuedBytes: Ref.Ref<number>;
  readonly maxBytes: number;
};

const eventBytes = (event: OrchestrationEvent) =>
  new TextEncoder().encode(JSON.stringify(event)).byteLength;

export const makeOrchestrationDeliveryHub = Effect.sync(() => {
  const captures = new Set<Capture>();

  const closeCapture = (capture: Capture) =>
    Effect.sync(() => captures.delete(capture)).pipe(
      Effect.andThen(Queue.shutdown(capture.events)),
    );

  const openCapture = (
    capacity = ORCHESTRATION_DELIVERY_LIVE_CAPTURE_CAPACITY,
    maxBytes = Number.MAX_SAFE_INTEGER,
  ) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const capture = {
          events: yield* Queue.dropping<OrchestrationEvent>(capacity),
          overflowed: yield* Deferred.make<void>(),
          overflowState: yield* Ref.make(false),
          queuedBytes: yield* Ref.make(0),
          maxBytes: Math.max(0, maxBytes),
        };
        captures.add(capture);
        return capture;
      }),
      closeCapture,
    ).pipe(
      Effect.map((capture) => ({
        stream: Stream.merge(
          Stream.fromQueue(capture.events).pipe(
            Stream.mapEffect((event) =>
              Ref.update(capture.queuedBytes, (bytes) =>
                Math.max(0, bytes - eventBytes(event)),
              ).pipe(Effect.as(event)),
            ),
          ),
          Stream.fromEffect(
            Deferred.await(capture.overflowed).pipe(
              Effect.andThen(
                Effect.die(new Error("orchestration delivery live capture overflowed")),
              ),
            ),
          ),
        ),
        isOverflowed: Ref.get(capture.overflowState),
        close: closeCapture(capture),
      })),
    );

  const markOverflowed = (capture: Capture) =>
    Effect.sync(() => captures.delete(capture)).pipe(
      Effect.andThen(Ref.set(capture.overflowState, true)),
      Effect.andThen(Deferred.succeed(capture.overflowed, undefined)),
      Effect.andThen(Queue.shutdown(capture.events)),
    );

  const publishToCapture = (capture: Capture, event: OrchestrationEvent) => {
    const bytes = eventBytes(event);
    return Ref.modify(capture.queuedBytes, (queued) => {
      const accepted = bytes <= capture.maxBytes && queued + bytes <= capture.maxBytes;
      return [accepted, accepted ? queued + bytes : queued] as const;
    }).pipe(
      Effect.flatMap((reserved) =>
        reserved
          ? Queue.offer(capture.events, event).pipe(
              Effect.flatMap((accepted) =>
                accepted
                  ? Effect.void
                  : Ref.update(capture.queuedBytes, (queued) => Math.max(0, queued - bytes)).pipe(
                      Effect.andThen(markOverflowed(capture)),
                    ),
              ),
            )
          : markOverflowed(capture),
      ),
    );
  };

  const publish = (event: OrchestrationEvent) =>
    Effect.forEach(Array.from(captures), (capture) => publishToCapture(capture, event), {
      discard: true,
    });

  return { openCapture, publish } as const;
});
