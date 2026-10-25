import * as Rpc from "effect/unstable/rpc/Rpc";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  TerminalSnapshotInput,
  TerminalSessionSnapshot,
  TerminalError,
} from "../workspace/terminal";

/** Read-only recovery endpoint; older servers reject it rather than falling back to open. */
export const WsTerminalSnapshotRpc = Rpc.make(WS_METHODS.terminalSnapshot, {
  payload: TerminalSnapshotInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});
