import * as Rpc from "effect/unstable/rpc/Rpc";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  RemoteBackendDeploymentError,
  RemoteBackendDeploymentInput,
  RemoteBackendDeploymentResult,
} from "./remoteBackendDeployment";

export const WsServerSetupRemoteBackendRpc = Rpc.make(WS_METHODS.serverSetupRemoteBackend, {
  payload: RemoteBackendDeploymentInput,
  success: RemoteBackendDeploymentResult,
  error: RemoteBackendDeploymentError,
});
