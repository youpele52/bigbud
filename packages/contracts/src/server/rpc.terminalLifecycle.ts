import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";
import { WS_METHODS } from "../constants/websocket.constant";
import { TerminalError } from "../workspace/terminal";
import {
  TerminalCloseDrainingHostsInput,
  TerminalCloseDrainingHostsResult,
  TerminalKeepOpenInput,
  TerminalRetrySetupInput,
  TerminalRetrySetupResult,
} from "../workspace/terminal.lifecycle";

/** Restart one terminal's idle timer; a terminal that is not idle-managed is left unchanged. */
export const WsTerminalKeepOpenRpc = Rpc.make(WS_METHODS.terminalKeepOpen, {
  payload: TerminalKeepOpenInput,
  success: Schema.Void,
  error: TerminalError,
});

/** Run a setup script the live limit refused, closing `evict` first. */
export const WsTerminalRetrySetupRpc = Rpc.make(WS_METHODS.terminalRetrySetup, {
  payload: TerminalRetrySetupInput,
  success: TerminalRetrySetupResult,
  error: TerminalError,
});

/** Stop old-version terminal hosts that can't be reconnected ("Close them"). */
export const WsTerminalCloseDrainingHostsRpc = Rpc.make(WS_METHODS.terminalCloseDrainingHosts, {
  payload: TerminalCloseDrainingHostsInput,
  success: TerminalCloseDrainingHostsResult,
  error: TerminalError,
});

export const TerminalLifecycleRpcs = [
  WsTerminalKeepOpenRpc,
  WsTerminalRetrySetupRpc,
  WsTerminalCloseDrainingHostsRpc,
] as const;
