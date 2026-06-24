import { Duration, Effect, Layer, Schedule } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
const WS_RECONNECT_MAX_DELAY_MS = 8_000;
const WS_RECONNECT_MAX_RETRIES = 7;

function getWsReconnectDelayMsForRetry(retryCount: number): number {
  return Math.min(WS_RECONNECT_INITIAL_DELAY_MS * 2 ** retryCount, WS_RECONNECT_MAX_DELAY_MS);
}

export interface MobileWsProtocolLifecycleHandlers {
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: () => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (details: { readonly code: number; readonly reason: string }) => void;
}

export function createMobileRpcProtocolLayer(
  wsUrl: string,
  handlers?: MobileWsProtocolLifecycleHandlers,
) {
  const trackingWebSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      handlers?.onAttempt?.(socketUrl);
      const socket = new globalThis.WebSocket(socketUrl, protocols);

      socket.addEventListener(
        "open",
        () => {
          handlers?.onOpen?.();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          handlers?.onError?.("Unable to connect to the desktop server.");
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          handlers?.onClose?.({
            code: event.code,
            reason: event.reason,
          });
        },
        { once: true },
      );

      return socket;
    },
  );
  const socketLayer = Socket.layerWebSocket(wsUrl).pipe(
    Layer.provide(trackingWebSocketConstructorLayer),
  );
  const retryPolicy = Schedule.addDelay(Schedule.recurs(WS_RECONNECT_MAX_RETRIES), (retryCount) =>
    Effect.succeed(Duration.millis(getWsReconnectDelayMsForRetry(retryCount))),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryPolicy,
      retryTransientErrors: true,
    }),
  );

  return protocolLayer.pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
}
