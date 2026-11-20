import { WsRpcGroup } from "@bigbud/contracts";
import { Duration, Effect, Layer, Schedule } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { APP_SERVER_NAME } from "../config/branding";
import { WsOptionalRpcTracker } from "./protocol.optionalRpc";
import { localWsTransportScope, type WsTransportScope } from "./wsTransport.scope";
import { WsReconnectBackoff } from "./wsReconnectPolicy";
import { WS_OPEN_TIMEOUT_MS, WsUpgradeGate } from "./wsUpgradeGate";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);

type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

/** Captured before the open resets the shared attempt counter. */
export interface WsOpenDetails {
  readonly reconnectAttempt: number;
}

export interface WsProtocolLifecycleHandlers {
  readonly isActive?: () => boolean;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: (details: WsOpenDetails) => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (details: { readonly code: number; readonly reason: string }) => void;
  readonly onProtocolFailure?: () => void;
}

/** Transport-lifetime reconnect state shared by every physical session generation. */
export interface WsConnectionControls {
  readonly backoff: WsReconnectBackoff;
  readonly upgradeGate: WsUpgradeGate;
}

export function createWsConnectionControls(): WsConnectionControls {
  return { backoff: new WsReconnectBackoff(), upgradeGate: new WsUpgradeGate() };
}

function defaultLifecycleHandlers(scope: WsTransportScope): Required<WsProtocolLifecycleHandlers> {
  return {
    isActive: () => true,
    onAttempt: scope.onAttempt,
    onOpen: scope.onOpen,
    onError: scope.onError,
    onClose: scope.onClose,
    onProtocolFailure: () => undefined,
  };
}

type ComposedLifecycleHandlers = Omit<Required<WsProtocolLifecycleHandlers>, "onOpen"> & {
  readonly onOpen: () => void;
};

function composeLifecycleHandlers(
  handlers: WsProtocolLifecycleHandlers | undefined,
  scope: WsTransportScope,
): ComposedLifecycleHandlers {
  const defaults = defaultLifecycleHandlers(scope);
  const isActive = handlers?.isActive ?? (() => true);

  return {
    isActive,
    onAttempt: (socketUrl) => {
      if (!isActive()) return;
      defaults.onAttempt(socketUrl);
      handlers?.onAttempt?.(socketUrl);
    },
    onOpen: () => {
      if (!isActive()) return;
      const details = { reconnectAttempt: scope.reconnectAttempt() };
      defaults.onOpen(details);
      handlers?.onOpen?.(details);
    },
    onError: (message) => {
      if (!isActive()) return;
      defaults.onError(message);
      handlers?.onError?.(message);
    },
    onClose: (details) => {
      if (!isActive()) return;
      defaults.onClose(details);
      handlers?.onClose?.(details);
    },
    onProtocolFailure: () => {
      if (isActive()) handlers?.onProtocolFailure?.();
    },
  };
}

export function createWsRpcProtocolLayer(
  url?: string,
  handlers?: WsProtocolLifecycleHandlers,
  controls: WsConnectionControls = createWsConnectionControls(),
  scope: WsTransportScope = localWsTransportScope,
) {
  const lifecycle = composeLifecycleHandlers(handlers, scope);
  const { backoff, upgradeGate } = controls;
  const optionalRpcs = new WsOptionalRpcTracker();
  const trackingWebSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      lifecycle.onAttempt(socketUrl);
      const socket = new globalThis.WebSocket(socketUrl, protocols);
      upgradeGate.track(socket);

      socket.addEventListener(
        "open",
        () => {
          if (lifecycle.isActive()) backoff.reset();
          lifecycle.onOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          lifecycle.onError(`Unable to connect to the ${APP_SERVER_NAME} WebSocket.`);
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          lifecycle.onClose({
            code: event.code,
            reason: event.reason,
          });
        },
        { once: true },
      );

      return socket;
    },
  );
  // Gate every physical upgrade, not just the initial RPC session. Desktop restarts
  // can take longer than the reconnect backoff; don't dial a known-unready backend.
  const guardedUrl = Effect.promise(async (signal) => {
    await upgradeGate.whenSettled();
    signal.throwIfAborted();
    return scope.resolveUrl(url, signal);
  }).pipe(
    // Socket acquisition is uninterruptible by default. A readiness wait must not
    // hold session disposal or manual reconnect hostage while the backend is down.
    Effect.interruptible,
  );
  const socketLayer = Socket.layerWebSocket(guardedUrl, { openTimeout: WS_OPEN_TIMEOUT_MS }).pipe(
    Layer.provide(trackingWebSocketConstructorLayer),
  );
  // Never give up: unbounded, full-jitter backoff that wake signals can cut short.
  const retryPolicy = Schedule.addDelay(Schedule.forever, () =>
    Effect.promise((signal) => {
      const delayMs = backoff.nextDelayMs();
      if (lifecycle.isActive()) scope.recordReconnectScheduled(delayMs);
      return backoff.sleep(delayMs, signal);
    }).pipe(Effect.as(Duration.zero)),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    Effect.map(
      RpcClient.makeProtocolSocket({
        retryPolicy,
        retryTransientErrors: true,
      }),
      (protocol) => ({
        ...protocol,
        run: (writeResponse) =>
          protocol.run((response) => {
            if (response._tag === "Chunk" || response._tag === "Exit") {
              if (lifecycle.isActive()) scope.acknowledgeRpcRequest(response.requestId);
              if (response._tag === "Exit") optionalRpcs.settle(response.requestId);
            } else if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
              // An older server rejecting an optional diagnostics RPC fails only that request.
              const scoped =
                response._tag === "Defect"
                  ? optionalRpcs.scopeUnknownTagDefect(response.defect)
                  : null;
              if (scoped) {
                return Effect.forEach(
                  scoped,
                  (exit) =>
                    Effect.suspend(() => {
                      if (lifecycle.isActive()) scope.acknowledgeRpcRequest(exit.requestId);
                      return writeResponse(exit);
                    }),
                  { discard: true },
                );
              }
              if (lifecycle.isActive()) scope.clearAllTrackedRpcRequests();
              optionalRpcs.clear();
              if (response._tag === "Defect" || response.error.reason._tag === "RpcClientDefect") {
                return Effect.suspend(() => writeResponse(response)).pipe(
                  Effect.ensuring(Effect.sync(() => lifecycle.onProtocolFailure())),
                );
              }
              // Socket close/open failures retain the socket protocol's existing retry owner.
              return Effect.suspend(() => writeResponse(response));
            }
            return Effect.suspend(() => writeResponse(response)).pipe(
              Effect.tapCause(() => Effect.sync(() => lifecycle.onProtocolFailure())),
            );
          }),
        send: (request, transferables) => {
          if (request._tag === "Request") {
            if (lifecycle.isActive()) scope.trackRpcRequestSent(request.id, request.tag);
          }
          optionalRpcs.trackSent(request);
          return protocol.send(request, transferables);
        },
      }),
    ),
  );

  return protocolLayer.pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
}
