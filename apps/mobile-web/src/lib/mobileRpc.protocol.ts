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
  readonly onRetry?: (details: { readonly retryCount: number; readonly delayMs: number }) => void;
  readonly onOpen?: () => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (details: { readonly code: number; readonly reason: string }) => void;
  readonly onExhausted?: () => void;
}

export function createMobileRpcWebSocketConstructor(handlers?: MobileWsProtocolLifecycleHandlers) {
  let attemptsSinceOpen = 0;
  let socketGeneration = 0;
  let activeSocketGeneration = 0;

  return (socketUrl: string, protocols?: string | string[]) => {
    const currentSocketGeneration = ++socketGeneration;
    activeSocketGeneration = currentSocketGeneration;
    attemptsSinceOpen += 1;
    handlers?.onAttempt?.(socketUrl);
    let socket: WebSocket;
    try {
      socket = new globalThis.WebSocket(socketUrl, protocols);
    } catch (error) {
      if (attemptsSinceOpen > WS_RECONNECT_MAX_RETRIES) handlers?.onExhausted?.();
      throw error;
    }

    const isCurrentSocket = () => currentSocketGeneration === activeSocketGeneration;
    socket.addEventListener(
      "open",
      () => {
        if (!isCurrentSocket()) return;
        attemptsSinceOpen = 0;
        handlers?.onOpen?.();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        if (isCurrentSocket()) handlers?.onError?.("Unable to connect to the desktop server.");
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => {
        if (!isCurrentSocket()) return;
        handlers?.onClose?.({
          code: event.code,
          reason: event.reason,
        });
        if (attemptsSinceOpen > WS_RECONNECT_MAX_RETRIES) {
          handlers?.onExhausted?.();
        }
      },
      { once: true },
    );

    return socket;
  };
}

export function createMobileRpcProtocolLayer(
  wsUrl: string,
  handlers?: MobileWsProtocolLifecycleHandlers,
) {
  const trackingWebSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    createMobileRpcWebSocketConstructor(handlers),
  );
  const socketLayer = Socket.layerWebSocket(wsUrl).pipe(
    Layer.provide(trackingWebSocketConstructorLayer),
  );
  const retryPolicy = Schedule.addDelay(Schedule.recurs(WS_RECONNECT_MAX_RETRIES), (retryCount) =>
    Effect.sync(() => {
      const delayMs = getWsReconnectDelayMsForRetry(retryCount);
      handlers?.onRetry?.({ retryCount, delayMs });
      return Duration.millis(delayMs);
    }),
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
