import type { OrchestrationDeliveryLifecycle } from "@bigbud/contracts";
import type { RemoteBackendIdentityPin } from "@bigbud/shared/remoteBackendIdentity";
import { createScopedDeliveryCursor } from "./orchestrationDeliveryCursor.scoped";
import { createWsConnectionControls } from "./protocol";
import {
  RemoteBackendClientRefused,
  resolvePinnedRemoteEndpoint,
  type RemoteClientRefusal,
  type RemoteEndpointResolver,
} from "./remoteBackendClientEndpoint";
import { createWsNativeApiContext } from "./wsNativeApi";
import { createWsRpcClient } from "./wsRpcClient";
import { WsTransport } from "./wsTransport";
import type { WsTransportScope } from "./wsTransport.scope";

/** Internal owner assembly, not a selector or trust prompt. No default local observers are used.
 * The supplied authenticated relay must bind the descriptor and socket to the same upstream. */
export async function openRemoteBackendClientOwner(options: {
  readonly pin: RemoteBackendIdentityPin;
  readonly resolveEndpoint: RemoteEndpointResolver;
  readonly signal: AbortSignal;
  readonly scope: Omit<WsTransportScope, "resolveUrl">;
  readonly cursorStorage: Parameters<typeof createScopedDeliveryCursor>[1];
  readonly onDeliveryLifecycle: (event: OrchestrationDeliveryLifecycle) => void;
  readonly onAdmissionFailure: (reason: RemoteClientRefusal) => void;
}) {
  const pin = Object.freeze({
    authority: Object.freeze({
      authorityId: options.pin.authority.authorityId,
      keyEpoch: options.pin.authority.keyEpoch,
      keyFingerprint: options.pin.authority.keyFingerprint,
    }),
    installationFingerprint: options.pin.installationFingerprint,
  });
  let initial: Awaited<ReturnType<typeof resolvePinnedRemoteEndpoint>>;
  try {
    initial = await resolvePinnedRemoteEndpoint(options.resolveEndpoint, pin, options.signal);
    options.signal.throwIfAborted();
  } catch (error) {
    options.scope.dispose();
    throw error;
  }
  let first: typeof initial | undefined = initial;
  let handshake = initial.handshake;
  let closed = false;
  let failure: RemoteClientRefusal | null = null;
  let context: ReturnType<typeof createWsNativeApiContext> | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    closed = true;
    return (disposal ??= context
      ? context.dispose()
      : Promise.resolve().then(() => options.scope.dispose()));
  };
  const scope: WsTransportScope = {
    ...options.scope,
    resolveUrl: async (_url, signal) => {
      signal.throwIfAborted();
      if (closed) throw new Error("Remote backend client owner is closed.");
      try {
        const endpoint =
          first ?? (await resolvePinnedRemoteEndpoint(options.resolveEndpoint, pin, signal));
        first = undefined;
        signal.throwIfAborted();
        if (closed) throw new Error("Remote backend client owner is closed.");
        handshake = endpoint.handshake;
        return endpoint.websocketUrl;
      } catch (error) {
        if (error instanceof RemoteBackendClientRefused) {
          failure = error.status;
          // Disposal fences RPC immediately. Do not await the protocol's own current resolver.
          void dispose().catch(() =>
            options.scope.onError("Remote backend client cleanup failed."),
          );
          options.onAdmissionFailure(error.status);
        }
        throw error;
      }
    },
  };
  const controls = createWsConnectionControls();
  let transport: WsTransport;
  try {
    transport = new WsTransport(undefined, undefined, controls, scope);
  } catch (error) {
    options.scope.dispose();
    throw error;
  }
  const rpcClient = createWsRpcClient(transport, () => controls.backoff.reset());
  try {
    context = createWsNativeApiContext({
      rpcClient,
      deliveryCursor: createScopedDeliveryCursor(pin, options.cursorStorage),
      onDeliveryLifecycle: options.onDeliveryLifecycle,
    });
  } catch (error) {
    await transport.dispose();
    throw error;
  }
  return {
    api: context.api,
    identity: pin,
    get handshake() {
      return handshake;
    },
    get admissionFailure() {
      return failure;
    },
    reconnect: () => rpcClient.reconnect(),
    dispose,
  };
}
