import type {
  RemoteBackendRelayLease,
  RemoteBackendRelayNativeApi,
} from "@bigbud/contracts/server/remoteBackendRelay.ts";
import { readLeaseEndpoint, RelayLeaseUnreachableError } from "./backendScope.endpoint";
import { createWsConnectionControls } from "./protocol";
import type { RemoteEndpointResolver } from "./remoteBackendClientEndpoint";
import { createRemoteBackendRelayRpcMethods } from "./wsRpcClient.remoteBackendRelay";
import { WsTransport } from "./wsTransport";
import { localWsTransportScope, type WsTransportScope } from "./wsTransport.scope";

const noop = () => undefined;

export interface RelayControl {
  readonly relay: RemoteBackendRelayNativeApi;
  readonly dispose: () => Promise<void>;
}

/** Leases are bound to a live local RPC connection, so a bound window keeps one private control
 * connection to the local backend. It is not the local singleton: it has its own transport,
 * backoff and silent observers, and exposes only the three relay methods. */
export function openLocalRelayControl(): RelayControl {
  let attempts = 0;
  const scope: WsTransportScope = {
    resolveUrl: localWsTransportScope.resolveUrl,
    reconnectAttempt: () => attempts,
    onAttempt: () => {
      attempts += 1;
    },
    onOpen: () => {
      attempts = 0;
    },
    onError: noop,
    onClose: noop,
    recordReconnectScheduled: noop,
    recordProtocolRecovery: noop,
    trackRpcRequestSent: noop,
    acknowledgeRpcRequest: noop,
    clearAllTrackedRpcRequests: noop,
    markWsInboundActivity: noop,
    dispose: noop,
  };
  const transport = new WsTransport(undefined, undefined, createWsConnectionControls(), scope);
  return {
    relay: createRemoteBackendRelayRpcMethods(transport),
    dispose: () => transport.dispose(),
  };
}

/** Owns this window's relay lease and renews it when the relay becomes unreachable, for example
 * after the local backend restarted and dropped the caller-bound lease. */
export function createRelayLeaseEndpoint(input: {
  readonly relay: RemoteBackendRelayNativeApi;
  readonly profileId: string;
  readonly randomId: () => string;
  readonly fetch: typeof fetch;
  readonly onLease: (lease: RemoteBackendRelayLease) => void;
}) {
  let lease: RemoteBackendRelayLease | null = null;
  let closed = false;

  const release = (selected: RemoteBackendRelayLease) =>
    input.relay.closeRemoteBackendRelay({ leaseId: selected.leaseId }).then(
      () => undefined,
      () => undefined,
    );

  const open = async (signal: AbortSignal) => {
    // The nonce lets a lost reply be cancelled before any lease ID is known.
    const requestId = input.randomId();
    let opened: RemoteBackendRelayLease;
    try {
      opened = await input.relay.openRemoteBackendRelay({ profileId: input.profileId, requestId });
    } catch (error) {
      void input.relay.closeRemoteBackendRelay({ requestId }).catch(() => undefined);
      throw error;
    }
    if (closed || signal.aborted) {
      await release(opened);
      signal.throwIfAborted();
      throw new Error("Remote backend relay lease owner is closed.");
    }
    lease = opened;
    input.onLease(opened);
    return opened;
  };

  const resolve: RemoteEndpointResolver = async (signal) => {
    if (closed) throw new Error("Remote backend relay lease owner is closed.");
    const current = lease;
    if (current) {
      try {
        return await readLeaseEndpoint(current, signal, input.fetch);
      } catch (error) {
        if (!(error instanceof RelayLeaseUnreachableError)) throw error;
        if (lease === current) lease = null;
        await release(current);
      }
    }
    return readLeaseEndpoint(await open(signal), signal, input.fetch);
  };

  return {
    resolve,
    close: async () => {
      closed = true;
      const current = lease;
      lease = null;
      if (current) await release(current);
    },
  };
}
