import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  RemoteBackendRelayError,
  type RemoteBackendRelayOpenInput,
  type RemoteBackendRelayCloseInput,
} from "@bigbud/contracts/server/remoteBackendRelay.ts";
import { sshMonitorCallerId } from "../ssh/sshMonitor.connections.ts";
import type { RemoteBackendRelayLeases } from "../remote-backend/clientRelay.leases.ts";

export function makeWsRpcRemoteBackendRelayHandlers(input: {
  readonly leases: RemoteBackendRelayLeases;
  readonly instanceId: string;
  readonly local: boolean;
}) {
  const run = <A>(
    clientId: number | undefined,
    operation: (callerId: string, signal: AbortSignal) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: (signal) => {
        if (!input.local)
          throw new RemoteBackendRelayError({
            code: "unavailable",
            message: "Relay leases require an authenticated local backend.",
          });
        const callerId = sshMonitorCallerId(input.instanceId, clientId);
        if (!callerId)
          throw new RemoteBackendRelayError({
            code: "caller-closed",
            message: "A live local RPC connection is required.",
          });
        return operation(callerId, signal);
      },
      catch: (error) =>
        Schema.is(RemoteBackendRelayError)(error)
          ? error
          : new RemoteBackendRelayError({
              code: "unavailable",
              message: "The local backend relay operation failed.",
            }),
    });
  return {
    [WS_METHODS.serverListRemoteBackendRelayProfiles]: (
      _input: unknown,
      options?: { readonly clientId: number },
    ) => run(options?.clientId, (caller, signal) => input.leases.list(caller, signal)),
    [WS_METHODS.serverOpenRemoteBackendRelay]: (
      selected: RemoteBackendRelayOpenInput,
      options?: { readonly clientId: number },
    ) =>
      run(options?.clientId, (caller, signal) =>
        input.leases.open(caller, selected.profileId, signal, selected.requestId),
      ),
    [WS_METHODS.serverCloseRemoteBackendRelay]: (
      selected: RemoteBackendRelayCloseInput,
      options?: { readonly clientId: number },
    ) =>
      run(options?.clientId, (caller) =>
        "leaseId" in selected
          ? input.leases.close(caller, selected.leaseId)
          : input.leases.cancel(caller, selected.requestId),
      ),
  };
}
