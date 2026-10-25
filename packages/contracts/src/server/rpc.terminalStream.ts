import * as Rpc from "effect/unstable/rpc/Rpc";
import { Schema } from "effect";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  TerminalOutputAckInput,
  TerminalSessionStreamInput,
  TerminalSessionStreamItem,
} from "../workspace/terminal.stream";
import { TerminalSearchInput, TerminalSearchResult } from "../workspace/terminal.search";

/** One terminal's events, flow-controlled by `terminal.outputAck`. */
export const WsSubscribeTerminalSessionRpc = Rpc.make(WS_METHODS.subscribeTerminalSession, {
  payload: TerminalSessionStreamInput,
  success: TerminalSessionStreamItem,
  stream: true,
});

/** Unknown or ended subscriptions are ignored; acknowledgements never fail the caller. */
export const WsTerminalOutputAckRpc = Rpc.make(WS_METHODS.terminalOutputAck, {
  payload: TerminalOutputAckInput,
  success: Schema.Void,
});

/** Search retained terminal output; an invalid query returns no hits rather than failing. */
export const WsTerminalSearchRpc = Rpc.make(WS_METHODS.terminalSearch, {
  payload: TerminalSearchInput,
  success: TerminalSearchResult,
});
