import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  RemoteBackendRelayListResult,
  RemoteBackendRelayOpenInput,
  RemoteBackendRelayLease,
  RemoteBackendRelayCloseInput,
  RemoteBackendRelayCloseResult,
  RemoteBackendRelayError,
} from "./remoteBackendRelay";

export const WsServerListRemoteBackendRelayProfilesRpc = Rpc.make(
  WS_METHODS.serverListRemoteBackendRelayProfiles,
  {
    payload: Schema.Struct({}),
    success: RemoteBackendRelayListResult,
    error: RemoteBackendRelayError,
  },
);
export const WsServerOpenRemoteBackendRelayRpc = Rpc.make(WS_METHODS.serverOpenRemoteBackendRelay, {
  payload: RemoteBackendRelayOpenInput,
  success: RemoteBackendRelayLease,
  error: RemoteBackendRelayError,
});
export const WsServerCloseRemoteBackendRelayRpc = Rpc.make(
  WS_METHODS.serverCloseRemoteBackendRelay,
  {
    payload: RemoteBackendRelayCloseInput,
    success: RemoteBackendRelayCloseResult,
    error: RemoteBackendRelayError,
  },
);
