import { Duration, Effect, Option, Stream } from "effect";
import { markWsInboundActivity } from "./wsActivity";

/** Applies an opt-in deadline to the request fiber, waiting for scoped cancellation to finish. */
export function withWsRequestDeadline<A, E, R>(
  request: Effect.Effect<A, E, R>,
  timeout?: Option.Option<Duration.Input>,
) {
  const scoped = Effect.scoped(request);
  return timeout && Option.isSome(timeout) ? Effect.timeout(scoped, timeout.value) : scoped;
}

/** Owns one finite consumer scope and rejects values from retired physical generations. */
export function scopedWsFiniteRequest<TValue, TClient>(
  clientPromise: Promise<TClient>,
  connect: (client: TClient) => Stream.Stream<TValue, Error, never>,
  listener: (value: TValue) => void | Promise<void>,
  isActive: () => boolean,
) {
  return Effect.scoped(
    Effect.promise(() => clientPromise).pipe(
      Effect.flatMap((client) =>
        Stream.runForEach(connect(client), (value) =>
          Effect.promise(() =>
            Promise.resolve().then(() => {
              if (!isActive()) return;
              markWsInboundActivity();
              return listener(value);
            }),
          ),
        ),
      ),
    ),
  );
}
