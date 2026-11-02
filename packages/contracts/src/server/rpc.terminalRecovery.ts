import * as Rpc from "effect/unstable/rpc/Rpc";
import { WS_METHODS } from "../constants/websocket.constant";
import { TerminalError } from "../workspace/terminal";
import { TerminalRecoveryInput, TerminalRecoveryResult } from "../workspace/terminal.recovery";

export const WsTerminalRecoveryRpc = Rpc.make(WS_METHODS.terminalRecovery, {
  payload: TerminalRecoveryInput,
  success: TerminalRecoveryResult,
  error: TerminalError,
});
