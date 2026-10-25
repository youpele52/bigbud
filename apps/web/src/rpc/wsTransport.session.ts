import { Effect, Exit, ManagedRuntime, Scope } from "effect";
import type { RpcClient } from "effect/unstable/rpc";

import { waitForDesktopBackendReady } from "./desktopBackendReady";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsConnectionControls,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolClient,
} from "./protocol";

export interface TransportSession {
  readonly clientPromise: Promise<WsRpcProtocolClient>;
  readonly closeScope: () => Promise<void>;
  readonly readinessController: AbortController;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
}

/** Owns the shared RPC client and physical protocol scope for one transport generation. */
export function createWsTransportSession(
  url: string | undefined,
  lifecycle: WsProtocolLifecycleHandlers,
  controls?: WsConnectionControls,
): TransportSession {
  const runtime = ManagedRuntime.make(createWsRpcProtocolLayer(url, lifecycle, controls));
  const clientScope = Effect.runSync(Scope.make());
  const readinessController = new AbortController();
  const clientPromise = waitForDesktopBackendReady(
    typeof window === "undefined" ? undefined : window.desktopBridge,
    readinessController.signal,
  ).then(() => {
    if (readinessController.signal.aborted) {
      throw new Error("WebSocket transport session closed before backend readiness.");
    }
    return runtime.runPromise(Scope.provide(clientScope)(makeWsRpcProtocolClient));
  });
  void clientPromise.catch(() => undefined);
  return {
    runtime,
    closeScope: () => Effect.runPromise(Scope.close(clientScope, Exit.void)),
    readinessController,
    clientPromise,
  };
}

export function closeWsTransportSession(session: TransportSession): Promise<void> {
  session.readinessController.abort();
  return session.closeScope().finally(() => session.runtime.dispose());
}
