import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";

import type { RpcUnaryMethod } from "./wsRpcClient.types";
import type { WsTransport } from "./wsTransport";

/** Remote runtime update RPCs (M3 WP-4C). Setup authority is enforced server-side; the local
 * backend answers `unauthorized`, so only a bound remote-backend window uses these. */
export interface RemoteRuntimeUpdateRpcMethods {
  readonly requestRemoteRuntimeUpdate: RpcUnaryMethod<
    typeof WS_METHODS.serverRequestRemoteRuntimeUpdate
  >;
  readonly getRemoteRuntimeUpdateStatus: RpcUnaryMethod<
    typeof WS_METHODS.serverGetRemoteRuntimeUpdateStatus
  >;
  /** Sends interruption consent for exactly the digest the user reviewed. Never call it without
   * an explicit user confirmation. */
  readonly consentRemoteRuntimeUpdateInterruption: RpcUnaryMethod<
    typeof WS_METHODS.serverConsentRemoteRuntimeUpdateInterruption
  >;
  readonly cancelRemoteRuntimeUpdate: RpcUnaryMethod<
    typeof WS_METHODS.serverCancelRemoteRuntimeUpdate
  >;
}

export function createRemoteRuntimeUpdateRpcMethods(
  transport: WsTransport,
): RemoteRuntimeUpdateRpcMethods {
  return {
    requestRemoteRuntimeUpdate: (input) =>
      transport.request((client) => client[WS_METHODS.serverRequestRemoteRuntimeUpdate](input)),
    getRemoteRuntimeUpdateStatus: (input) =>
      transport.request((client) => client[WS_METHODS.serverGetRemoteRuntimeUpdateStatus](input)),
    consentRemoteRuntimeUpdateInterruption: (input) =>
      transport.request((client) =>
        client[WS_METHODS.serverConsentRemoteRuntimeUpdateInterruption](input),
      ),
    cancelRemoteRuntimeUpdate: (input) =>
      transport.request((client) => client[WS_METHODS.serverCancelRemoteRuntimeUpdate](input)),
  };
}
