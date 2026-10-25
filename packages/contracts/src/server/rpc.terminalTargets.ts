import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";
import { WS_METHODS } from "../constants/websocket.constant";
import { TerminalWslDistributions, TerminalWslDiscoveryError } from "../workspace/terminal.wsl";

export const WsTerminalWslDistributionsRpc = Rpc.make(WS_METHODS.terminalWslDistributions, {
  payload: Schema.Struct({}),
  success: TerminalWslDistributions,
  error: TerminalWslDiscoveryError,
});
