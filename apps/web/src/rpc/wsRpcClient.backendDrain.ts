import { BACKEND_DRAIN_WS_METHODS } from "@bigbud/contracts/server/backendDrain.ts";

import type { RpcUnaryMethod } from "./wsRpcClient.types";
import type { WsTransport } from "./wsTransport";

export interface BackendDrainRpcMethods {
  readonly getBackendDrainConsent: RpcUnaryMethod<typeof BACKEND_DRAIN_WS_METHODS.get>;
  readonly decideBackendDrainConsent: RpcUnaryMethod<typeof BACKEND_DRAIN_WS_METHODS.decide>;
}

export function createBackendDrainRpcMethods(transport: WsTransport): BackendDrainRpcMethods {
  return {
    getBackendDrainConsent: () =>
      transport.request((client) => client[BACKEND_DRAIN_WS_METHODS.get](undefined)),
    decideBackendDrainConsent: (input) =>
      transport.request((client) => client[BACKEND_DRAIN_WS_METHODS.decide](input)),
  };
}
