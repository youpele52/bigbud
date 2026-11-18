import type { RemoteBackendRelayNativeApi } from "@bigbud/contracts/server/remoteBackendRelay.ts";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { WsTransport } from "./wsTransport";

/** Caller retains its request nonce across retry/cancel; no renderer deployment or remote secret. */
export function createRemoteBackendRelayRpcMethods(
  transport: WsTransport,
): RemoteBackendRelayNativeApi {
  return {
    listRemoteBackendRelayProfiles: () =>
      transport.request((client) => client[WS_METHODS.serverListRemoteBackendRelayProfiles]({})),
    openRemoteBackendRelay: (input) =>
      transport.request((client) => client[WS_METHODS.serverOpenRemoteBackendRelay](input)),
    closeRemoteBackendRelay: (input) =>
      transport.request((client) => client[WS_METHODS.serverCloseRemoteBackendRelay](input)),
  };
}
