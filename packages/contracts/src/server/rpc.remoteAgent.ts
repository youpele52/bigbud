import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerGetRemoteAgentUpdateStatusError,
  ServerGetRemoteAgentUpdateStatusInput,
  ServerRemoteAgentUpdateStatus,
} from "./server";
import {
  ServerRestartRemoteAgentError,
  ServerRestartRemoteAgentInput,
  ServerRestartRemoteAgentResult,
  ServerGetRemoteAgentRestartStatusInput,
} from "./server.remoteRestart";

export const WsServerRestartRemoteAgentRpc = Rpc.make(WS_METHODS.serverRestartRemoteAgent, {
  payload: ServerRestartRemoteAgentInput,
  success: ServerRestartRemoteAgentResult,
  error: ServerRestartRemoteAgentError,
});

export const WsServerGetRemoteAgentRestartStatusRpc = Rpc.make(
  WS_METHODS.serverGetRemoteAgentRestartStatus,
  {
    payload: ServerGetRemoteAgentRestartStatusInput,
    success: ServerRestartRemoteAgentResult,
    error: ServerRestartRemoteAgentError,
  },
);

export const WsServerGetRemoteAgentUpdateStatusRpc = Rpc.make(
  WS_METHODS.serverGetRemoteAgentUpdateStatus,
  {
    payload: ServerGetRemoteAgentUpdateStatusInput,
    success: ServerRemoteAgentUpdateStatus,
    error: ServerGetRemoteAgentUpdateStatusError,
  },
);
