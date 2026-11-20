import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";
import { WS_METHODS } from "../constants/websocket.constant";
import { TerminalError, TerminalSessionSnapshot } from "../workspace/terminal";
import {
  TerminalRemoteInventoryInput,
  TerminalRemoteInventory,
  TerminalRemoteAttachInput,
  TerminalRemoteDetachInput,
} from "../workspace/terminal.remote";

export const WsTerminalRemoteInventoryRpc = Rpc.make(WS_METHODS.terminalRemoteInventory, {
  payload: TerminalRemoteInventoryInput,
  success: TerminalRemoteInventory,
  error: TerminalError,
});
export const WsTerminalRemoteAttachRpc = Rpc.make(WS_METHODS.terminalRemoteAttach, {
  payload: TerminalRemoteAttachInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});
export const WsTerminalRemoteDetachRpc = Rpc.make(WS_METHODS.terminalRemoteDetach, {
  payload: TerminalRemoteDetachInput,
  success: Schema.Void,
  error: TerminalError,
});
export const WsTerminalRemoteStopRpc = Rpc.make(WS_METHODS.terminalRemoteStop, {
  payload: TerminalRemoteAttachInput,
  success: Schema.Void,
  error: TerminalError,
});
