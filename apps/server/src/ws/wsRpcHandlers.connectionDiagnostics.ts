import { Effect } from "effect";
import type {
  ServerGetWsConnectionDiagnosticsInput,
  WsConnectionDiagnosticsReport,
} from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";

import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";

export function makeWsRpcConnectionDiagnosticsHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverReportWsConnectionDiagnostics]: (input: WsConnectionDiagnosticsReport) =>
      observeRpcEffect(
        WS_METHODS.serverReportWsConnectionDiagnostics,
        context.connectionDiagnostics
          .recordReport(input)
          .pipe(Effect.map((entry) => ({ sequence: entry.sequence }))),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverGetWsConnectionDiagnostics]: (input: ServerGetWsConnectionDiagnosticsInput) =>
      observeRpcEffect(
        WS_METHODS.serverGetWsConnectionDiagnostics,
        context.connectionDiagnostics.snapshot(input.limit),
        { "rpc.aggregate": "server" },
      ),
  };
}
