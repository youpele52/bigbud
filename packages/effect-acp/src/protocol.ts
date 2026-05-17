import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Stdio from "effect/Stdio";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { CLIENT_METHODS } from "./_generated/meta.gen.ts";
import * as AcpError from "./errors.ts";
import { makeProtocolRouting } from "./protocol.routing.ts";

export interface AcpProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export type AcpIncomingNotification =
  | {
      readonly _tag: "SessionUpdate";
      readonly method: typeof CLIENT_METHODS.session_update;
      readonly params: typeof AcpSchema.SessionNotification.Type;
    }
  | {
      readonly _tag: "ElicitationComplete";
      readonly method: typeof CLIENT_METHODS.session_elicitation_complete;
      readonly params: typeof AcpSchema.ElicitationCompleteNotification.Type;
    }
  | {
      readonly _tag: "ExtNotification";
      readonly method: string;
      readonly params: unknown;
    };

export interface AcpPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<AcpError.AcpError>;
  readonly serverRequestMethods: ReadonlySet<string>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: AcpIncomingNotification,
  ) => Effect.Effect<void, AcpError.AcpError, never>;
  readonly onExtRequest?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError, never>;
  readonly onTermination?: (error: AcpError.AcpError) => Effect.Effect<void, never, never>;
}

export interface AcpPatchedProtocol {
  readonly clientProtocol: RpcClient.Protocol["Service"];
  readonly serverProtocol: RpcServer.Protocol["Service"];
  readonly incoming: Stream.Stream<AcpIncomingNotification>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
}

const parserFactory = RpcSerialization.ndJsonRpc();

export const makeAcpPatchedProtocol = Effect.fn("makeAcpPatchedProtocol")(function* (
  options: AcpPatchedProtocolOptions,
): Effect.fn.Return<AcpPatchedProtocol, never, Scope.Scope> {
  const parser = parserFactory.makeUnsafe();
  const serverQueue = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
  const clientQueue = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
  const notificationQueue = yield* Queue.unbounded<AcpIncomingNotification>();
  const disconnects = yield* Queue.unbounded<number>();
  const outgoing = yield* Queue.unbounded<string | Uint8Array, Cause.Done<void>>();
  const nextRequestId = yield* Ref.make(1n);
  const terminationHandled = yield* Ref.make(false);
  const extPending = yield* Ref.make(
    new Map<string, Deferred.Deferred<unknown, AcpError.AcpError>>(),
  );

  const logProtocol = (event: AcpProtocolLogEvent) => {
    if (event.direction === "incoming" && !options.logIncoming) {
      return Effect.void;
    }
    if (event.direction === "outgoing" && !options.logOutgoing) {
      return Effect.void;
    }
    return (
      options.logger?.(event) ??
      Effect.logDebug("ACP protocol event").pipe(Effect.annotateLogs({ event }))
    );
  };

  const offerOutgoing = Effect.fn("offerOutgoing")(function* (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ) {
    yield* logProtocol({
      direction: "outgoing",
      stage: "decoded",
      payload: message,
    });

    const encoded = yield* Effect.try({
      try: () => parser.encode(message),
      catch: (cause) =>
        new AcpError.AcpProtocolParseError({
          detail: "Failed to encode ACP message",
          cause,
        }),
    });

    if (encoded) {
      yield* logProtocol({
        direction: "outgoing",
        stage: "raw",
        payload: typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded),
      });

      yield* Queue.offer(outgoing, encoded).pipe(Effect.asVoid);
    }
  });

  const { handleTermination, removeExtPending, routeDecodedMessage } = makeProtocolRouting({
    serverQueue,
    clientQueue,
    notificationQueue,
    disconnects,
    extPending,
    terminationHandled,
    options,
    offerOutgoing,
  });

  yield* options.stdio.stdin.pipe(
    Stream.runForEach((data) =>
      logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: typeof data === "string" ? data : new TextDecoder().decode(data),
      }).pipe(
        Effect.flatMap(() =>
          Effect.try({
            try: () =>
              parser.decode(data) as ReadonlyArray<
                RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
              >,
            catch: (cause) => {
              const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
              console.error("[ACP DEBUG] Parse failed for:", raw.substring(0, 500));
              return new AcpError.AcpProtocolParseError({
                detail: "Failed to decode ACP wire message",
                cause,
              });
            },
          }),
        ),
        Effect.tap((messages) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: messages,
          }),
        ),
        Effect.tapErrorTag("AcpProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              detail: error.detail,
              cause: error.cause,
            },
          }),
        ),
        Effect.flatMap((messages) =>
          Effect.forEach(messages, routeDecodedMessage, {
            discard: true,
          }),
        ),
      ),
    ),
    Effect.matchEffect({
      onFailure: (error) => {
        const normalized: AcpError.AcpError = Schema.is(AcpError.AcpError)(error)
          ? error
          : new AcpError.AcpTransportError({
              detail: error instanceof Error ? error.message : String(error),
              cause: error,
            });
        return handleTermination(() => Effect.succeed(normalized));
      },
      onSuccess: () =>
        handleTermination(
          () =>
            options.terminationError ??
            Effect.succeed(
              new AcpError.AcpTransportError({
                detail: "ACP input stream ended",
                cause: new Error("ACP input stream ended"),
              }),
            ),
        ),
    }),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout()), Effect.forkScoped);

  const clientProtocol: RpcClient.Protocol["Service"] = {
    run: (f) =>
      Stream.fromQueue(clientQueue).pipe(
        Stream.runForEach((message) => f(message)),
        Effect.forever,
      ),
    send: (request) => offerOutgoing(request).pipe(Effect.mapError(toRpcClientError)),
    supportsAck: true,
    supportsTransferables: false,
  };

  const serverProtocol: RpcServer.Protocol["Service"] = {
    run: (f) =>
      Stream.fromQueue(serverQueue).pipe(
        Stream.runForEach((message) => f(0, message)),
        Effect.forever,
      ),
    disconnects,
    send: (_clientId, response) => offerOutgoing(response).pipe(Effect.orDie),
    end: (_clientId) => Queue.end(outgoing),
    clientIds: Effect.succeed(new Set([0])),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: true,
  };

  const sendNotification = Effect.fn("sendNotification")(function* (
    method: string,
    payload: unknown,
  ) {
    yield* offerOutgoing({
      _tag: "Request",
      id: "",
      tag: method,
      payload,
      headers: [],
    });
  });

  const sendRequest = Effect.fn("sendRequest")(function* (method: string, payload: unknown) {
    const requestId = yield* Ref.modify(
      nextRequestId,
      (current) => [current, current + 1n] as const,
    );
    const deferred = yield* Deferred.make<unknown, AcpError.AcpError>();
    yield* Ref.update(extPending, (pending) => new Map(pending).set(String(requestId), deferred));
    yield* offerOutgoing({
      _tag: "Request",
      id: String(requestId),
      tag: method,
      payload,
      headers: [],
    }).pipe(
      Effect.catch((error) =>
        removeExtPending(String(requestId)).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => removeExtPending(String(requestId))),
    );
  });

  return {
    clientProtocol,
    serverProtocol,
    get incoming() {
      return Stream.fromQueue(notificationQueue);
    },
    request: sendRequest,
    notify: sendNotification,
  } satisfies AcpPatchedProtocol;
});

function toRpcClientError(error: AcpError.AcpError): RpcClientError.RpcClientError {
  return new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: error.message,
      cause: error,
    }),
  });
}
