import { Deferred, Effect, Option, Queue, Schedule, Schema, Stream } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import * as Socket from "effect/unstable/socket/Socket";
import { makeCommandGate } from "../startup/serverRuntimeStartup";

export const OwnershipRpcs = RpcGroup.make(
  Rpc.make("config", {
    payload: { mode: Schema.Literals(["immediate", "async", "healthy", "factoryThrow"]) },
    success: Schema.Number,
    stream: true,
  }),
  Rpc.make("unary", { success: Schema.Number }),
  Rpc.make("slowUnary", { success: Schema.Number }),
  Rpc.make("acceptedCommand", { success: Schema.Number }),
);

/** Yields to real fibers rather than hiding a registration race behind a timer. */
export const awaitOwnershipCondition = (condition: () => boolean): Effect.Effect<void> => {
  const poll: Effect.Effect<void> = Effect.suspend(() =>
    condition() ? Effect.void : Effect.andThen(Effect.yieldNow, poll),
  );
  return poll.pipe(Effect.timeout("5 seconds"), Effect.orDie);
};

/** Uses exported compiled RPC codecs and the actual socket client protocol over JSON frames. */
export const makeRpcOwnershipHarness = Effect.fn("makeRpcOwnershipHarness")(function* (options?: {
  readonly corruptChunks?: boolean;
  readonly dropAcks?: boolean;
}) {
  const requests = yield* Queue.unbounded<string>();
  const responses = yield* Queue.unbounded<string>();
  const disconnects = yield* Queue.unbounded<number>();
  const healthyUpdates = yield* Queue.unbounded<number>();
  const releaseBad = yield* Deferred.make<void>();
  const ready = yield* Deferred.make<void>();
  const releaseUnary = yield* Deferred.make<number>();
  const commandEnqueued = yield* Deferred.make<void>();
  const commandGate = yield* makeCommandGate({
    onCommandEnqueued: () => Deferred.succeed(commandEnqueued, undefined).pipe(Effect.asVoid),
  });
  const parser = RpcSerialization.json.makeUnsafe();
  let corruptChunkConsumed = false;
  const state = {
    activeBad: 0,
    activeHealthy: 0,
    maximumBad: 0,
    finalizers: 0,
    activeUnary: 0,
    unaryFinalizers: 0,
    acceptedRuns: 0,
    badActiveAtFailure: [] as Array<number>,
    received: [] as Array<FromClientEncoded>,
  };
  const tracked = (healthy: boolean, stream: Stream.Stream<number>) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => {
          if (healthy) state.activeHealthy += 1;
          else {
            state.activeBad += 1;
            state.maximumBad = Math.max(state.maximumBad, state.activeBad);
          }
          return stream;
        }),
        () =>
          Effect.sync(() => {
            if (healthy) state.activeHealthy -= 1;
            else state.activeBad -= 1;
            state.finalizers += 1;
          }),
      ),
    );
  const invalid = "schema-invalid" as unknown as number;
  const handlers = OwnershipRpcs.toLayer({
    config: ({ mode }) => {
      if (mode === "factoryThrow") throw new Error("synchronous handler factory failed");
      const stream =
        mode === "healthy"
          ? Stream.concat(Stream.make(1), Stream.fromQueue(healthyUpdates))
          : mode === "async"
            ? Stream.concat(
                Stream.fromEffect(Effect.as(Deferred.await(releaseBad), invalid)),
                Stream.never,
              )
            : Stream.concat(Stream.make(invalid), Stream.never);
      return tracked(mode === "healthy", stream);
    },
    unary: () => Effect.succeed(invalid),
    slowUnary: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          state.activeUnary += 1;
        }),
        () =>
          Effect.sync(() => {
            state.activeUnary -= 1;
            state.unaryFinalizers += 1;
          }),
      ).pipe(Effect.andThen(Deferred.await(releaseUnary))),
    acceptedCommand: () =>
      commandGate
        .enqueueCommand(
          Effect.sync(() => {
            state.acceptedRuns += 1;
            return state.acceptedRuns;
          }),
        )
        .pipe(Effect.orDie),
  });

  const serverProtocol = RpcServer.Protocol.of({
    run: (handle) =>
      Effect.andThen(
        Deferred.succeed(ready, undefined),
        Effect.forever(
          Effect.flatMap(Queue.take(requests), (frame) =>
            Effect.forEach(
              parser.decode(frame) as Array<FromClientEncoded>,
              (message) => {
                state.received.push(message);
                if (message._tag === "Ping") {
                  return Queue.offer(responses, JSON.stringify({ _tag: "Pong" })).pipe(
                    Effect.asVoid,
                  );
                }
                if (options?.dropAcks && message._tag === "Ack") return Effect.void;
                return handle(0, message);
              },
              { discard: true },
            ),
          ),
        ),
      ),
    disconnects,
    send: (_clientId, response) => {
      if (response._tag === "Exit" && response.exit._tag === "Failure") {
        state.badActiveAtFailure.push(state.activeBad);
      }
      const corrupt = options?.corruptChunks && !corruptChunkConsumed && response._tag === "Chunk";
      if (corrupt) corruptChunkConsumed = true;
      const value =
        corrupt && response._tag === "Chunk"
          ? { ...response, values: ["invalid-on-wire"] }
          : response;
      return Queue.offer(responses, parser.encode(value) as string).pipe(Effect.asVoid);
    },
    end: () => Effect.void,
    clientIds: Effect.succeed(new Set([0])),
    initialMessage: Effect.succeed(Option.none()),
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: false,
  });
  yield* RpcServer.make(OwnershipRpcs, { disableFatalDefects: true }).pipe(
    Effect.provide(handlers),
    Effect.provideService(RpcServer.Protocol, serverProtocol),
    Effect.forkScoped,
  );
  yield* Deferred.await(ready);

  const socket: Socket.Socket = {
    [Socket.TypeId]: Socket.TypeId,
    runRaw: (handler, opts) =>
      Effect.andThen(
        opts?.onOpen ?? Effect.void,
        Effect.forever(
          Effect.flatMap(Queue.take(responses), (frame) => handler(frame) ?? Effect.void),
        ),
      ),
    run: (handler, opts) =>
      Effect.andThen(
        opts?.onOpen ?? Effect.void,
        Effect.forever(
          Effect.flatMap(
            Queue.take(responses),
            (frame) => handler(new TextEncoder().encode(frame)) ?? Effect.void,
          ),
        ),
      ),
    writer: Effect.succeed((frame) =>
      Socket.isCloseEvent(frame)
        ? Queue.offer(disconnects, 0).pipe(Effect.asVoid)
        : Queue.offer(
            requests,
            typeof frame === "string" ? frame : new TextDecoder().decode(frame),
          ).pipe(Effect.asVoid),
    ),
  };
  const protocol = yield* RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
    Effect.provideService(Socket.Socket, socket),
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
  );
  const client = yield* RpcClient.make(OwnershipRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  );
  return {
    client,
    state,
    releaseBad,
    releaseUnary,
    commandEnqueued,
    commandGate,
    publishHealthy: (value: number) => Queue.offer(healthyUpdates, value),
    inject: (message: FromServerEncoded) =>
      Queue.offer(responses, parser.encode(message) as string),
    injectRaw: (frame: string) => Queue.offer(responses, frame),
  };
});
