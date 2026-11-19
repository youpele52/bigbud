import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  SystemSearchError,
  SystemSearchQueryInput,
  SystemSearchTierUpdate,
} from "../search/systemSearch";

/**
 * Mod+F workspace-wide search (plan §4). A finite stream of tier updates; unsubscribing interrupts
 * the server fiber, which cancels every agent operation started for the query. UI-only: never
 * reachable from thread tools, MCP bridges or providers.
 */
export const WsSearchQueryRpc = Rpc.make(WS_METHODS.searchQuery, {
  payload: SystemSearchQueryInput,
  success: SystemSearchTierUpdate,
  error: SystemSearchError,
  stream: true,
});
