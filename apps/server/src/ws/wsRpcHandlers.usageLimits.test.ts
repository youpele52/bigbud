import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { makeServerWsRpcHandlers } from "./wsRpcHandlers.server.ts";

it("routes subscription refresh to quota-only registry reads, never recovery", async () => {
  const read = vi.fn();
  const recover = vi.fn();
  const context = {
    providerRegistry: {
      refreshUsageLimits: Effect.sync(() => {
        read();
        return [];
      }),
      refresh: recover,
    },
  } as unknown as WsRpcContext;
  const handler = makeServerWsRpcHandlers(context)[WS_METHODS.serverRefreshUsageLimits];
  expect(await Effect.runPromise(handler({}))).toEqual({ providers: [] });
  expect(read).toHaveBeenCalledOnce();
  expect(recover).not.toHaveBeenCalled();
});
