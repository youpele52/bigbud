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
import {
  ServerListDisconnectedExecutionTargetsInput,
  ServerListDisconnectedExecutionTargetsResult,
  ServerRemoteConnectionError,
  ServerRemoteConnectionInput,
  ServerRemoteConnectionResult,
} from "./server.remoteConnection";

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

export const WsServerDisconnectExecutionTargetRpc = Rpc.make(
  WS_METHODS.serverDisconnectExecutionTarget,
  {
    payload: ServerRemoteConnectionInput,
    success: ServerRemoteConnectionResult,
    error: ServerRemoteConnectionError,
  },
);

export const WsServerConnectExecutionTargetRpc = Rpc.make(WS_METHODS.serverConnectExecutionTarget, {
  payload: ServerRemoteConnectionInput,
  success: ServerRemoteConnectionResult,
  error: ServerRemoteConnectionError,
});

export const WsServerListDisconnectedExecutionTargetsRpc = Rpc.make(
  WS_METHODS.serverListDisconnectedExecutionTargets,
  {
    payload: ServerListDisconnectedExecutionTargetsInput,
    success: ServerListDisconnectedExecutionTargetsResult,
    error: ServerRemoteConnectionError,
  },
);
