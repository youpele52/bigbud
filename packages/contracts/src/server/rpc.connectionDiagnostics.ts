import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerGetWsConnectionDiagnosticsInput,
  ServerWsConnectionDiagnosticsSnapshot,
  WsConnectionDiagnosticsReport,
  WsConnectionDiagnosticsReportResult,
} from "./connectionDiagnostics";

export const WsServerReportWsConnectionDiagnosticsRpc = Rpc.make(
  WS_METHODS.serverReportWsConnectionDiagnostics,
  {
    payload: WsConnectionDiagnosticsReport,
    success: WsConnectionDiagnosticsReportResult,
  },
);

export const WsServerGetWsConnectionDiagnosticsRpc = Rpc.make(
  WS_METHODS.serverGetWsConnectionDiagnostics,
  {
    payload: ServerGetWsConnectionDiagnosticsInput,
    success: ServerWsConnectionDiagnosticsSnapshot,
  },
);
