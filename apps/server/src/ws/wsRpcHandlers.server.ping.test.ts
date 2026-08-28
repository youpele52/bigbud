import { WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeServerWsRpcHandlers } from "./wsRpcHandlers.server.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

it.effect("answers the liveness RPC without loading server configuration", () =>
  Effect.gen(function* () {
    const handlers = makeServerWsRpcHandlers({} as WsRpcContext);
    const result = yield* handlers[WS_METHODS.serverPing]({});

    assert.isNotNaN(Date.parse(result.serverTime));
  }),
);
