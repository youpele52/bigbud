import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { CLIENT_METHODS } from "./_generated/meta.gen.ts";
import * as AcpError from "./errors.ts";
import type { AcpIncomingNotification, AcpPatchedProtocolOptions } from "./protocol.ts";

const decodeSessionUpdate = Schema.decodeUnknownEffect(AcpSchema.SessionNotification);
const decodeElicitationComplete = Schema.decodeUnknownEffect(
  AcpSchema.ElicitationCompleteNotification,
);

interface ProtocolRoutingDeps {
  readonly serverQueue: Queue.Queue<RpcMessage.FromClientEncoded>;
  readonly clientQueue: Queue.Queue<RpcMessage.FromServerEncoded>;
  readonly notificationQueue: Queue.Queue<AcpIncomingNotification>;
  readonly disconnects: Queue.Queue<number>;
  readonly extPending: Ref.Ref<Map<string, Deferred.Deferred<unknown, AcpError.AcpError>>>;
  readonly terminationHandled: Ref.Ref<boolean>;
  readonly options: AcpPatchedProtocolOptions;
  readonly offerOutgoing: (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ) => Effect.Effect<void, AcpError.AcpError, never>;
}

export const makeProtocolRouting = ({
  serverQueue,
  clientQueue,
  notificationQueue,
  disconnects,
  extPending,
  terminationHandled,
  options,
  offerOutgoing,
}: ProtocolRoutingDeps) => {
  const resolveExtPending = (
    requestId: string,
    onFound: (deferred: Deferred.Deferred<unknown, AcpError.AcpError>) => Effect.Effect<void>,
  ) =>
    Ref.modify(extPending, (pending) => {
      const deferred = pending.get(requestId);
      if (!deferred) {
        return [Effect.void, pending] as const;
      }
      const next = new Map(pending);
      next.delete(requestId);
      return [onFound(deferred), next] as const;
    }).pipe(Effect.flatten);

  const removeExtPending = (requestId: string) =>
    Ref.update(extPending, (pending) => {
      if (!pending.has(requestId)) {
        return pending;
      }
      const next = new Map(pending);
      next.delete(requestId);
      return next;
    });

  const completeExtPendingFailure = (requestId: string, error: AcpError.AcpError) =>
    resolveExtPending(requestId, (deferred) => Deferred.fail(deferred, error));

  const completeExtPendingSuccess = (requestId: string, value: unknown) =>
    resolveExtPending(requestId, (deferred) => Deferred.succeed(deferred, value));

  const failAllExtPending = (error: AcpError.AcpError) =>
    Ref.getAndSet(extPending, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach([...pending.values()], (deferred) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const dispatchNotification = (notification: AcpIncomingNotification) =>
    Queue.offer(notificationQueue, notification).pipe(
      Effect.andThen(
        options.onNotification
          ? options.onNotification(notification).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const emitClientProtocolError = (error: AcpError.AcpError) =>
    Queue.offer(clientQueue, {
      _tag: "ClientProtocolError",
      error: new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: error.message,
          cause: error,
        }),
      }),
    }).pipe(Effect.asVoid);

  const handleTermination = (classify: () => Effect.Effect<AcpError.AcpError | undefined>) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) {
        return [Effect.void, true] as const;
      }
      return [
        Effect.gen(function* () {
          yield* Queue.offer(disconnects, 0);
          const error = yield* classify();
          if (!error) {
            return;
          }
          yield* failAllExtPending(error);
          yield* emitClientProtocolError(error);
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten);

  const respondWithSuccess = (requestId: string, value: unknown) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Success",
        value,
      },
    });

  const respondWithError = (requestId: string, error: AcpError.AcpRequestError) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: error.toProtocolError(),
          },
        ],
      },
    });

  const handleExtRequest = (message: RpcMessage.RequestEncoded) => {
    if (!options.onExtRequest) {
      return respondWithError(message.id, AcpError.AcpRequestError.methodNotFound(message.tag));
    }
    return options.onExtRequest(message.tag, message.payload).pipe(
      Effect.matchEffect({
        onFailure: (error) => respondWithError(message.id, normalizeToRequestError(error)),
        onSuccess: (value) => respondWithSuccess(message.id, value),
      }),
    );
  };

  const handleRequestEncoded = (message: RpcMessage.RequestEncoded) => {
    if (message.id === "") {
      if (message.tag === CLIENT_METHODS.session_update) {
        return decodeSessionUpdate(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "SessionUpdate",
                method: CLIENT_METHODS.session_update,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError(
            (cause) =>
              new AcpError.AcpProtocolParseError({
                detail: `Invalid ${CLIENT_METHODS.session_update} notification payload`,
                cause,
              }),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      if (message.tag === CLIENT_METHODS.session_elicitation_complete) {
        return decodeElicitationComplete(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "ElicitationComplete",
                method: CLIENT_METHODS.session_elicitation_complete,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError(
            (cause) =>
              new AcpError.AcpProtocolParseError({
                detail: `Invalid ${CLIENT_METHODS.session_elicitation_complete} notification payload`,
                cause,
              }),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      return dispatchNotification({
        _tag: "ExtNotification",
        method: message.tag,
        params: message.payload,
      });
    }

    if (!options.serverRequestMethods.has(message.tag)) {
      return handleExtRequest(message).pipe(
        Effect.catch(() => respondWithError(message.id, AcpError.AcpRequestError.internalError())),
        Effect.asVoid,
      );
    }

    return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
  };

  const handleExitEncoded = (message: RpcMessage.ResponseExitEncoded) =>
    Ref.get(extPending).pipe(
      Effect.flatMap((pending) => {
        if (!pending.has(message.requestId)) {
          return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
        }
        if (message.exit._tag === "Success") {
          return completeExtPendingSuccess(message.requestId, message.exit.value);
        }
        const failure = message.exit.cause.find((entry) => entry._tag === "Fail");
        if (failure && isProtocolError(failure.error)) {
          return completeExtPendingFailure(
            message.requestId,
            AcpError.AcpRequestError.fromProtocolError(failure.error),
          );
        }
        return completeExtPendingFailure(
          message.requestId,
          AcpError.AcpRequestError.internalError("Extension request failed"),
        );
      }),
    );

  const routeDecodedMessage = (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ): Effect.Effect<void, AcpError.AcpError> => {
    switch (message._tag) {
      case "Request":
        return handleRequestEncoded(message);
      case "Exit":
        return handleExitEncoded(message);
      case "Chunk":
        return Ref.get(extPending).pipe(
          Effect.flatMap((pending) =>
            pending.has(message.requestId)
              ? completeExtPendingFailure(
                  message.requestId,
                  AcpError.AcpRequestError.internalError(
                    "Streaming extension responses are not supported",
                  ),
                )
              : Queue.offer(clientQueue, message).pipe(Effect.asVoid),
          ),
        );
      case "Defect":
      case "ClientProtocolError":
      case "Pong":
        return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
      case "Ack":
      case "Interrupt":
      case "Ping":
      case "Eof":
        return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
    }
  };

  return {
    handleTermination,
    removeExtPending,
    routeDecodedMessage,
  };
};

function isProtocolError(
  value: unknown,
): value is { code: number; message: string; data?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function normalizeToRequestError(error: AcpError.AcpError): AcpError.AcpRequestError {
  return Schema.is(AcpError.AcpRequestError)(error)
    ? error
    : AcpError.AcpRequestError.internalError(error.message);
}
