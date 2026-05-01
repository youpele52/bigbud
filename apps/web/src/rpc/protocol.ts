import { WsRpcGroup } from "@bigbud/contracts";
import { Duration, Effect, Layer, Schedule } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { APP_SERVER_NAME } from "../config/branding";
import { resolveServerUrl } from "../lib/utils";
import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";
import {
  getWsReconnectDelayMsForRetry,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  WS_RECONNECT_MAX_RETRIES,
} from "./wsConnectionState";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);

type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

export interface WsProtocolLifecycleHandlers {
  readonly isActive?: () => boolean;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: () => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (details: { readonly code: number; readonly reason: string }) => void;
}

function defaultLifecycleHandlers(): Required<WsProtocolLifecycleHandlers> {
  return {
    isActive: () => true,
    onAttempt: (socketUrl) => {
      recordWsConnectionAttempt(socketUrl);
    },
    onOpen: () => {
      recordWsConnectionOpened();
    },
    onError: (message) => {
      clearAllTrackedRpcRequests();
      recordWsConnectionErrored(message);
    },
    onClose: (details) => {
      clearAllTrackedRpcRequests();
      recordWsConnectionClosed(details);
    },
  };
}

function composeLifecycleHandlers(
  handlers?: WsProtocolLifecycleHandlers,
): Required<WsProtocolLifecycleHandlers> {
  const defaults = defaultLifecycleHandlers();
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
      defaults.onOpen();
      handlers?.onOpen?.();
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
  };
}

export function createWsRpcProtocolLayer(url?: string, handlers?: WsProtocolLifecycleHandlers) {
  const lifecycle = composeLifecycleHandlers(handlers);
  const resolvedUrl = resolveServerUrl({
    url,
    protocol: window.location.protocol === "https:" ? "wss" : "ws",
    pathname: "/ws",
  });
  const trackingWebSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      lifecycle.onAttempt(socketUrl);
      const socket = new globalThis.WebSocket(socketUrl, protocols);

      socket.addEventListener(
        "open",
        () => {
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
  const socketLayer = Socket.layerWebSocket(resolvedUrl).pipe(
    Layer.provide(trackingWebSocketConstructorLayer),
  );
  const retryPolicy = Schedule.addDelay(Schedule.recurs(WS_RECONNECT_MAX_RETRIES), (retryCount) =>
    Effect.succeed(Duration.millis(getWsReconnectDelayMsForRetry(retryCount) ?? 0)),
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
              acknowledgeRpcRequest(response.requestId);
            } else if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
              clearAllTrackedRpcRequests();
            }
            return writeResponse(response);
          }),
        send: (request, transferables) => {
          if (request._tag === "Request") {
            trackRpcRequestSent(request.id, request.tag);
          }
          return protocol.send(request, transferables);
        },
      }),
    ),
  );

  return protocolLayer.pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
}
