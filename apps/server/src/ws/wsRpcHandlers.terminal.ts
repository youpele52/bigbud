import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";
import { makeRemoteTerminalHandlers } from "./wsRpcHandlers.terminalRemote";

export function makeTerminalHandlers(context: WsRpcContext) {
  return {
    ...makeRemoteTerminalHandlers(context),
    [WS_METHODS.terminalOpen]: (input: Parameters<WsRpcContext["terminalManager"]["open"]>[0]) =>
      observeRpcEffect(WS_METHODS.terminalOpen, context.terminalManager.open(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalSnapshot]: (
      input: Parameters<WsRpcContext["terminalManager"]["snapshot"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.terminalSnapshot, context.terminalManager.snapshot(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalWrite]: (input: Parameters<WsRpcContext["terminalManager"]["write"]>[0]) =>
      observeRpcEffect(WS_METHODS.terminalWrite, context.terminalManager.write(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalResize]: (
      input: Parameters<WsRpcContext["terminalManager"]["resize"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.terminalResize, context.terminalManager.resize(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalClear]: (input: Parameters<WsRpcContext["terminalManager"]["clear"]>[0]) =>
      observeRpcEffect(WS_METHODS.terminalClear, context.terminalManager.clear(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalRestart]: (
      input: Parameters<WsRpcContext["terminalManager"]["restart"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.terminalRestart, context.terminalManager.restart(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalClose]: (input: Parameters<WsRpcContext["terminalManager"]["close"]>[0]) =>
      observeRpcEffect(WS_METHODS.terminalClose, context.terminalManager.close(input), {
        "rpc.aggregate": "terminal",
      }),
  };
}
