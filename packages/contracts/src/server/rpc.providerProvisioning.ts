import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  ProviderProvisionInput,
  ProviderProvisionResult,
  ProviderProvisioningError,
  ProviderProvisioningStatus,
  ProviderProvisioningStatusInput,
} from "./providerProvisioning";

/**
 * Provisioning changes the host, so it needs setup authority (D10), enforced server-side: in
 * remote mode only the authenticated remote client socket (the SSH-relayed laptop) grants it;
 * paired mobile viewers are denied and their RPC group has no provisioning RPCs.
 */
export class ProviderProvisioningSetupAuthority extends RpcMiddleware.Service<ProviderProvisioningSetupAuthority>()(
  "bigbud/server/ProviderProvisioningSetupAuthority",
  { error: ProviderProvisioningError },
) {}

export const WsServerGetProviderProvisioningStatusRpc = Rpc.make(
  WS_METHODS.serverGetProviderProvisioningStatus,
  {
    payload: ProviderProvisioningStatusInput,
    success: ProviderProvisioningStatus,
    error: ProviderProvisioningError,
  },
);

export const WsServerProvisionProviderRpc = Rpc.make(WS_METHODS.serverProvisionProvider, {
  payload: ProviderProvisionInput,
  success: ProviderProvisionResult,
  error: ProviderProvisioningError,
}).middleware(ProviderProvisioningSetupAuthority);
