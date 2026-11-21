import * as Effect from "effect/Effect";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import type {
  TerminalKeepOpenInput,
  TerminalRetrySetupInput,
} from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";

/**
 * Lifecycle controls (plan C1 scaffolding). This backend has no idle close or live limit yet,
 * so `keepOpen` has nothing to restart and no setup script is ever refused for a retry.
 */
export function makeWsRpcTerminalLifecycleHandlers(_context: WsRpcContext) {
  return {
    [WS_METHODS.terminalKeepOpen]: (_input: TerminalKeepOpenInput) =>
      observeRpcEffect(WS_METHODS.terminalKeepOpen, Effect.void, { "rpc.aggregate": "terminal" }),
    [WS_METHODS.terminalRetrySetup]: (input: TerminalRetrySetupInput) =>
      observeRpcEffect(
        WS_METHODS.terminalRetrySetup,
        Effect.fail(
          new TerminalExecutionTargetError({
            threadId: input.threadId,
            terminalId: "unknown",
            executionTargetId: "unknown",
            detail:
              "Retrying a setup script isn't supported by this backend yet. Run the setup script again from the project menu.",
          }),
        ),
        { "rpc.aggregate": "terminal" },
      ),
  };
}
