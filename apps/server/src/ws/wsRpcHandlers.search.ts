import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  SystemSearchError,
  type SystemSearchQueryInput,
} from "@bigbud/contracts/search/systemSearch.ts";
import { Effect, Option, Stream } from "effect";

import { observeRpcStream } from "../observability/RpcInstrumentation";
import { SystemSearch } from "../search/Services/SystemSearch.ts";

const unavailable = Stream.fail(new SystemSearchError({ message: "Search is unavailable." }));

/** `search.query` on the main WebSocket surface only; the mobile gateway never exposes it. */
export const makeWsRpcSearchHandlers = Effect.gen(function* () {
  const search = yield* Effect.serviceOption(SystemSearch);
  return {
    [WS_METHODS.searchQuery]: (input: SystemSearchQueryInput) =>
      observeRpcStream(
        WS_METHODS.searchQuery,
        Option.isSome(search) ? search.value.query(input) : unavailable,
        { "rpc.aggregate": "search" },
      ),
  };
});
