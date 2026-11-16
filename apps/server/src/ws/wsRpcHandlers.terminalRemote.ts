import * as Effect from "effect/Effect";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import type {
  TerminalRemoteInventoryInput,
  TerminalRemoteAttachInput,
  TerminalRemoteDetachInput,
} from "@bigbud/contracts/workspace/terminal.remote.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";

const unavailable = () =>
  Effect.fail(
    new TerminalExecutionTargetError({
      threadId: "unknown",
      terminalId: "unknown",
      executionTargetId: "unknown",
      detail:
        "Persistent terminal controls are unavailable on this backend. Existing work was left unchanged.",
    }),
  );

export function makeRemoteTerminalHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.terminalRemoteInventory]: (input: TerminalRemoteInventoryInput) =>
      observeRpcEffect(
        WS_METHODS.terminalRemoteInventory,
        context.terminalManager.remoteInventory?.(input) ?? unavailable(),
      ),
    [WS_METHODS.terminalRemoteAttach]: (input: TerminalRemoteAttachInput) =>
      observeRpcEffect(
        WS_METHODS.terminalRemoteAttach,
        context.terminalManager.remoteAttach?.(input) ?? unavailable(),
      ),
    [WS_METHODS.terminalRemoteDetach]: (input: TerminalRemoteDetachInput) =>
      observeRpcEffect(
        WS_METHODS.terminalRemoteDetach,
        context.terminalManager.remoteDetach?.(input) ?? unavailable(),
      ),
    [WS_METHODS.terminalRemoteStop]: (input: TerminalRemoteAttachInput) =>
      observeRpcEffect(
        WS_METHODS.terminalRemoteStop,
        context.terminalManager.remoteStop?.(input) ?? unavailable(),
      ),
  };
}
