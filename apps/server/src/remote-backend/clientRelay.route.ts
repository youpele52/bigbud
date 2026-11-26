import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { ServerConfig } from "../startup/config.ts";
import {
  RemoteBackendRelayProfiles,
  unavailableRemoteBackendRelayProfiles,
} from "./clientRelay.profiles.ts";
import { makeRemoteBackendRelayLeases } from "./clientRelay.leases.ts";
import { clientRelayAllowedOrigins } from "./clientRelay.origins.ts";
import { openRemoteBackendRelayProfileOwner } from "./clientRelay.profileOwner.ts";
import type { ClientRelaySshOwner } from "./clientRelay.ssh.owner.ts";
import { sshMonitorCallerId } from "../ssh/sshMonitor.connections.ts";
import { makeWsRpcRemoteBackendRelayHandlers } from "../ws/wsRpcHandlers.remoteBackendRelay.ts";
import { registerBackendDrainStop } from "../startup/backendDrain.stops.ts";
import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionClientRelayOwner } from "./clientRelay.ssh.owner.production.ts";

const noProtocolClients = async (): Promise<ReadonlySet<number>> => new Set();

/** The HTTP server Scope owns leases; a temporary per-RPC layer-build scope never owns them. */
export const makeRemoteBackendRelayRoute = Effect.fn("makeRemoteBackendRelayRoute")(function* (
  instanceId: string,
  scope: Scope.Scope,
  injectedOwner?: ClientRelaySshOwner,
) {
  const config = yield* ServerConfig;
  const directory = yield* Effect.serviceOption(RemoteBackendRelayProfiles);
  // W2 T-backend: every channel is a live-owner relay lease.
  const sshOwner =
    injectedOwner ?? makeProductionClientRelayOwner({ owner: readSshOwnerProductionOwner });
  let readClients: () => Promise<ReadonlySet<number>> = noProtocolClients;
  const origins = clientRelayAllowedOrigins(config);
  const leases = makeRemoteBackendRelayLeases({
    profiles: Option.getOrElse(directory, () => unavailableRemoteBackendRelayProfiles),
    isCallerActive: async (caller) => {
      const client = Number(caller.slice(instanceId.length + 1));
      return sshMonitorCallerId(instanceId, client) === caller && (await readClients()).has(client);
    },
    openProfile: (profile, signal) =>
      openRemoteBackendRelayProfileOwner(profile, origins, signal, sshOwner),
  });
  // The upgrade drain closes live relay leases before any pane closes (W3.2 step 1).
  const unregisterDrainStop = registerBackendDrainStop("relays", () => leases.closeAll());
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(unregisterDrainStop).pipe(Effect.andThen(Effect.promise(() => leases.dispose()))),
  );
  return {
    handlers: makeWsRpcRemoteBackendRelayHandlers({
      leases,
      instanceId,
      local: config.mode !== "remote" && Boolean(config.authToken),
    }),
    lifecycle: {
      ready: (read: () => Promise<ReadonlySet<number>>) => {
        readClients = read;
      },
      disconnect: (clientId: number) =>
        leases.closeCaller(sshMonitorCallerId(instanceId, clientId) ?? ""),
    },
  };
});
