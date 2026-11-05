import { Duration, Effect, Option, Stream } from "effect";
import { markWsInboundActivity } from "./wsActivity";
import type { WsRpcProtocolClient } from "./protocol";
import type { TransportSession } from "./wsTransport.session";

/** Applies an opt-in deadline to the request fiber, waiting for scoped cancellation to finish. */
export function withWsRequestDeadline<A, E, R>(
  request: Effect.Effect<A, E, R>,
  timeout?: Option.Option<Duration.Input>,
) {
  const scoped = Effect.scoped(request);
  return timeout && Option.isSome(timeout) ? Effect.timeout(scoped, timeout.value) : scoped;
}

/** A single monotonic budget covers reconnect, protocol readiness, and request completion. */
export async function requestWsUnary<T>(
  execute: (client: WsRpcProtocolClient) => Effect.Effect<T, Error, never>,
  timeout: Option.Option<Duration.Input> | undefined,
  reconnectOperation: Promise<void> | null,
  currentSession: () => TransportSession,
): Promise<T> {
  const deadline =
    timeout && Option.isSome(timeout)
      ? performance.now() + Duration.toMillis(Duration.fromInputUnsafe(timeout.value))
      : null;
  const remaining = () =>
    deadline === null ? undefined : Duration.millis(Math.max(0, deadline - performance.now()));
  if (reconnectOperation) {
    if (deadline === null) await reconnectOperation;
    else
      await Effect.runPromise(
        Effect.promise(() => reconnectOperation).pipe(Effect.timeout(remaining()!)),
      );
  }
  // Do not send a request after its budget was consumed by reconnect.
  if (deadline !== null && deadline <= performance.now())
    throw new Error("WebSocket RPC request timed out before dispatch");
  const session = currentSession();
  return session.runtime.runPromise(
    withWsRequestDeadline(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) => Effect.suspend(() => execute(client))),
      ),
      deadline === null ? timeout : Option.some(remaining()!),
    ),
  );
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
