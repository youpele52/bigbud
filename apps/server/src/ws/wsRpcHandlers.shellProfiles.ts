import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { TerminalShellProfilesInput } from "@bigbud/contracts/workspace/terminal.shellProfiles.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";

export function makeShellProfileHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.terminalShellProfiles]: (input: TerminalShellProfilesInput) =>
      observeRpcEffect(
        WS_METHODS.terminalShellProfiles,
        context.terminalManager.listShellProfiles(input),
        { "rpc.aggregate": "terminal" },
      ),
  };
}
