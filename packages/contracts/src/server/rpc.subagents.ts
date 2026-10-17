import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import { ProviderStopSubagentError, ProviderStopSubagentInput } from "./subagents";

export const WsProviderStopSubagentRpc = Rpc.make(WS_METHODS.providerStopSubagent, {
  payload: ProviderStopSubagentInput,
  success: Schema.Void,
  error: ProviderStopSubagentError,
});
