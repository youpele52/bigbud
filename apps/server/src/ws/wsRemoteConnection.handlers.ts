import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { ServerRemoteConnectionInput } from "@bigbud/contracts/server/server.remoteConnection.ts";

import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext.ts";
import {
  connectExecutionTargetEffect,
  disconnectExecutionTargetEffect,
  listDisconnectedExecutionTargetsEffect,
} from "./wsRemoteConnection.ts";
import { makeRemoteDisconnectSteps } from "./wsRemoteConnection.steps.ts";

/** User-initiated Disconnect/Connect for SSH remote workspaces. */
export function makeRemoteConnectionHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverDisconnectExecutionTarget]: (input: ServerRemoteConnectionInput) =>
      observeRpcEffect(
        WS_METHODS.serverDisconnectExecutionTarget,
        disconnectExecutionTargetEffect(
          input,
          makeRemoteDisconnectSteps({
            providerService: context.providerService,
            terminalManager: context.terminalManager,
          }),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverConnectExecutionTarget]: (input: ServerRemoteConnectionInput) =>
      observeRpcEffect(
        WS_METHODS.serverConnectExecutionTarget,
        connectExecutionTargetEffect(input),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverListDisconnectedExecutionTargets]: () =>
      observeRpcEffect(
        WS_METHODS.serverListDisconnectedExecutionTargets,
        listDisconnectedExecutionTargetsEffect(),
        { "rpc.aggregate": "server" },
      ),
  };
}
