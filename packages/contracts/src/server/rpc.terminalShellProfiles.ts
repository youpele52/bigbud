import * as Rpc from "effect/unstable/rpc/Rpc";
import { WS_METHODS } from "../constants/websocket.constant";
import { TerminalError } from "../workspace/terminal";
import {
  TerminalShellProfileInventory,
  TerminalShellProfilesInput,
} from "../workspace/terminal.shellProfiles";

export const WsTerminalShellProfilesRpc = Rpc.make(WS_METHODS.terminalShellProfiles, {
  payload: TerminalShellProfilesInput,
  success: TerminalShellProfileInventory,
  error: TerminalError,
});
