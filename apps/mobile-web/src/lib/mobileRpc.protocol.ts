import { Duration, Effect, Layer, Schedule } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { MobileHostAdmissionRejectedError } from "./mobileHostConnection";

import { isExplicitMobileAuthorizationClose } from "../logic/mobileConnection.logic";

const WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
const WS_RECONNECT_MAX_DELAY_MS = 8_000;
const WS_RECONNECT_MAX_RETRIES = 7;

/**
 * Exponential backoff with equal jitter: the delay is uniformly spread over
 * [cap/2, cap], so phones recovering from the same network change do not
 * reconnect in lockstep, while every retry still waits at least half the cap.
 */
export function getWsReconnectDelayMsForRetry(
  retryCount: number,
  random: () => number = Math.random,
): number {
  const cap = Math.min(WS_RECONNECT_INITIAL_DELAY_MS * 2 ** retryCount, WS_RECONNECT_MAX_DELAY_MS);
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return Math.round(cap / 2 + (unit * cap) / 2);
}

export interface MobileWsProtocolLifecycleHandlers {
  readonly beforeConnect?: (signal: AbortSignal) => Promise<void>;
  readonly onIdentityRejected?: (message: string) => void;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onRetry?: (details: { readonly retryCount: number; readonly delayMs: number }) => void;
  readonly onOpen?: () => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (details: { readonly code: number; readonly reason: string }) => void;
  readonly onExhausted?: () => void;
}

export function createMobileRpcWebSocketConstructor(handlers?: MobileWsProtocolLifecycleHandlers) {
  let socketGeneration = 0;
  let activeSocketGeneration = 0;

  return (socketUrl: string, protocols?: string | string[]) => {
    const currentSocketGeneration = ++socketGeneration;
    activeSocketGeneration = currentSocketGeneration;
    handlers?.onAttempt?.(socketUrl);
    const socket = new globalThis.WebSocket(socketUrl, protocols);

    const isCurrentSocket = () => currentSocketGeneration === activeSocketGeneration;
    socket.addEventListener(
      "open",
      () => {
        if (!isCurrentSocket()) return;
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
      },
      { once: true },
    );

    return socket;
  };
}

/** One terminal authorization latch shared by socket evidence and its retry schedule. */
export function createMobileRpcReconnectPolicy(handlers?: MobileWsProtocolLifecycleHandlers) {
  let authorizationRejected = false;
  let identityRejected = false;
  const constructSocket = createMobileRpcWebSocketConstructor({
    ...handlers,
    onClose: (details) => {
      authorizationRejected ||= isExplicitMobileAuthorizationClose(details);
      handlers?.onClose?.(details);
    },
  });
  const createSocket: typeof constructSocket = (url, protocols) => {
    // A revocation can arrive after schedule evaluation while its delay is sleeping.
    if (authorizationRejected) throw new Error("Mobile session authorization rejected.");
    if (identityRejected) throw new Error("Mobile backend identity admission rejected.");
    return constructSocket(url, protocols);
  };
  const retryPolicy = Schedule.forever.pipe(
    Schedule.while(({ attempt }) => {
      if (authorizationRejected || identityRejected) return false;
      if (attempt <= WS_RECONNECT_MAX_RETRIES) return true;
      handlers?.onExhausted?.();
      return false;
    }),
    Schedule.addDelay((retryCount) =>
      Effect.sync(() => {
        const delayMs = getWsReconnectDelayMsForRetry(retryCount);
        handlers?.onRetry?.({ retryCount, delayMs });
        return Duration.millis(delayMs);
      }),
    ),
  );
  const acquireSocket = (url: string) =>
    Effect.tryPromise({
      try: async (signal) => {
        await handlers?.beforeConnect?.(signal);
        signal.throwIfAborted();
        return createSocket(url);
      },
      catch: (cause) => {
        if (cause instanceof MobileHostAdmissionRejectedError) {
          identityRejected = true;
          handlers?.onIdentityRejected?.(cause.message);
        }
        return new Socket.SocketError({
          reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
        });
      },
    });
  return { createSocket, acquireSocket, retryPolicy };
}

export function createMobileRpcProtocolLayer(
  wsUrl: string,
  handlers?: MobileWsProtocolLifecycleHandlers,
) {
  const { createSocket, acquireSocket, retryPolicy } = createMobileRpcReconnectPolicy(handlers);
  const socketLayer = handlers?.beforeConnect
    ? Layer.effect(
        Socket.Socket,
        Socket.fromWebSocket(
          Effect.acquireRelease(acquireSocket(wsUrl), (socket) =>
            Effect.sync(() => socket.close(1000)),
          ),
        ),
      )
    : Socket.layerWebSocket(wsUrl).pipe(
        Layer.provide(Layer.succeed(Socket.WebSocketConstructor, createSocket)),
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
