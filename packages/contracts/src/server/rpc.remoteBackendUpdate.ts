import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  RemoteRuntimeUpdateCancelInput,
  RemoteRuntimeUpdateConsentInput,
  RemoteRuntimeUpdateError,
  RemoteRuntimeUpdateOperation,
  RemoteRuntimeUpdateRequestInput,
  RemoteRuntimeUpdateRequestResult,
  RemoteRuntimeUpdateStatus,
  RemoteRuntimeUpdateStatusInput,
} from "./remoteBackendUpdate";

/**
 * D10: every update RPC requires setup authority, enforced server-side. Only the authenticated
 * remote client socket grants it; local and paired mobile connections are denied.
 */
export class RemoteRuntimeUpdateSetupAuthority extends RpcMiddleware.Service<RemoteRuntimeUpdateSetupAuthority>()(
  "bigbud/server/RemoteRuntimeUpdateSetupAuthority",
  { error: RemoteRuntimeUpdateError },
) {}

export const WsServerRequestRemoteRuntimeUpdateRpc = Rpc.make(
  WS_METHODS.serverRequestRemoteRuntimeUpdate,
  {
    payload: RemoteRuntimeUpdateRequestInput,
    success: RemoteRuntimeUpdateRequestResult,
    error: RemoteRuntimeUpdateError,
  },
).middleware(RemoteRuntimeUpdateSetupAuthority);

export const WsServerGetRemoteRuntimeUpdateStatusRpc = Rpc.make(
  WS_METHODS.serverGetRemoteRuntimeUpdateStatus,
  {
    payload: RemoteRuntimeUpdateStatusInput,
    success: RemoteRuntimeUpdateStatus,
    error: RemoteRuntimeUpdateError,
  },
).middleware(RemoteRuntimeUpdateSetupAuthority);

export const WsServerConsentRemoteRuntimeUpdateInterruptionRpc = Rpc.make(
  WS_METHODS.serverConsentRemoteRuntimeUpdateInterruption,
  {
    payload: RemoteRuntimeUpdateConsentInput,
    success: RemoteRuntimeUpdateOperation,
    error: RemoteRuntimeUpdateError,
  },
).middleware(RemoteRuntimeUpdateSetupAuthority);

export const WsServerCancelRemoteRuntimeUpdateRpc = Rpc.make(
  WS_METHODS.serverCancelRemoteRuntimeUpdate,
  {
    payload: RemoteRuntimeUpdateCancelInput,
    success: RemoteRuntimeUpdateOperation,
    error: RemoteRuntimeUpdateError,
  },
).middleware(RemoteRuntimeUpdateSetupAuthority);
