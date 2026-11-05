import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { RpcUnaryMethod, RpcUnaryNoArgMethod } from "./wsRpcClient.types";

export interface WsRpcMonitorMethods {
  readonly sampleSshMonitor: RpcUnaryMethod<typeof WS_METHODS.serverSampleSshMonitor>;
  readonly listConnectedSshMonitors: RpcUnaryNoArgMethod<
    typeof WS_METHODS.serverListConnectedSshMonitors
  >;
}
