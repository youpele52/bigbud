import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type {
  ServerGetRemoteAgentRestartStatusInput,
  ServerRestartRemoteAgentInput,
  ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart";
import type { RpcUnaryMethod, RpcUnaryNoArgMethod } from "./wsRpcClient.types";

/** Remote service restart and user-initiated SSH connection controls. */
export interface WsRpcRemoteAgentMethods {
  readonly restartRemoteAgent: (
    input: ServerRestartRemoteAgentInput,
  ) => Promise<ServerRestartRemoteAgentResult>;
  readonly getRemoteAgentRestartStatus: (
    input: ServerGetRemoteAgentRestartStatusInput,
  ) => Promise<ServerRestartRemoteAgentResult>;
  readonly disconnectExecutionTarget: RpcUnaryMethod<
    typeof WS_METHODS.serverDisconnectExecutionTarget
  >;
  readonly connectExecutionTarget: RpcUnaryMethod<typeof WS_METHODS.serverConnectExecutionTarget>;
  readonly listDisconnectedExecutionTargets: RpcUnaryNoArgMethod<
    typeof WS_METHODS.serverListDisconnectedExecutionTargets
  >;
}
