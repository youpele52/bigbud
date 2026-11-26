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
import {
  TerminalForgetRetainedShellOwnersResult,
  TerminalRetainedShellOwners,
  TerminalRetainedShellOwnersInput,
} from "../workspace/terminal.shellOwners";

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
export const WsTerminalRetainedShellOwnersRpc = Rpc.make(WS_METHODS.terminalRetainedShellOwners, {
  payload: TerminalRetainedShellOwnersInput,
  success: TerminalRetainedShellOwners,
  error: TerminalError,
});
/** Forgets only the given thread's unverifiable shell records; the remote shell is not stopped. */
export const WsTerminalForgetRetainedShellOwnersRpc = Rpc.make(
  WS_METHODS.terminalForgetRetainedShellOwners,
  {
    payload: TerminalRetainedShellOwnersInput,
    success: TerminalForgetRetainedShellOwnersResult,
    error: TerminalError,
  },
);

export const TerminalRemoteRpcs = [
  WsTerminalRemoteInventoryRpc,
  WsTerminalRemoteAttachRpc,
  WsTerminalRemoteDetachRpc,
  WsTerminalRemoteStopRpc,
  WsTerminalRetainedShellOwnersRpc,
  WsTerminalForgetRetainedShellOwnersRpc,
] as const;
