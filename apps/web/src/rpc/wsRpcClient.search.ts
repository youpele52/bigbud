import { WS_METHODS } from "@bigbud/contracts";

import type { WsTransport } from "./wsTransport";
import type { WsRpcClient } from "./wsRpcClient.types";

/** `search.query`: one finite stream per query; aborting `signal` cancels it on the server. */
export function createSearchRpcClient(transport: WsTransport): WsRpcClient["search"] {
  return {
    query: (input, onUpdate, signal) =>
      transport.requestStream((client) => client[WS_METHODS.searchQuery](input), onUpdate, signal),
  };
}
