import { WS_METHODS } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { TRACE_RETAIN_ATTRIBUTE } from "../observability/TracePolicy.ts";
import { makeServerWsRpcHandlers } from "./wsRpcHandlers.server.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { PING_TRACE_SAMPLE_INTERVAL_MS, PingTraceSampler } from "./wsPingTraceSampler.ts";

it.effect("answers the liveness RPC without loading server configuration", () =>
  Effect.gen(function* () {
    const handlers = makeServerWsRpcHandlers({} as WsRpcContext);
    const result = yield* handlers[WS_METHODS.serverPing]({});

    assert.isNotNaN(Date.parse(result.serverTime));
  }),
);

it.effect("keeps the first ping of each connection in production traces", () =>
  Effect.gen(function* () {
    const handlers = makeServerWsRpcHandlers({} as WsRpcContext);
    const pingSpan = (clientId: number) =>
      handlers[WS_METHODS.serverPing]({}, { clientId }).pipe(
        Effect.andThen(Effect.currentSpan),
        Effect.withSpan("ws.rpc.server.ping"),
      );

    const first = yield* pingSpan(1);
    const repeat = yield* pingSpan(1);
    const otherConnection = yield* pingSpan(2);

    assert.strictEqual(first.attributes.get(TRACE_RETAIN_ATTRIBUTE), true);
    assert.strictEqual(first.attributes.get("ws.client_id"), 1);
    assert.strictEqual(first.attributes.get("rpc.method"), WS_METHODS.serverPing);
    assert.strictEqual(repeat.attributes.get(TRACE_RETAIN_ATTRIBUTE), undefined);
    assert.strictEqual(otherConnection.attributes.get(TRACE_RETAIN_ATTRIBUTE), true);
  }),
);

describe("PingTraceSampler", () => {
  it("samples each connection once per interval", () => {
    const sampler = new PingTraceSampler();

    assert.isTrue(sampler.shouldRetain(1, 0));
    assert.isFalse(sampler.shouldRetain(1, 5_000));
    assert.isFalse(sampler.shouldRetain(1, PING_TRACE_SAMPLE_INTERVAL_MS - 1));
    assert.isTrue(sampler.shouldRetain(1, PING_TRACE_SAMPLE_INTERVAL_MS));
    assert.isTrue(sampler.shouldRetain(2, 5_000));
  });

  it("stays bounded by evicting the connection sampled longest ago", () => {
    const sampler = new PingTraceSampler(60_000, 2);
    sampler.shouldRetain(1, 0);
    sampler.shouldRetain(2, 1);
    sampler.shouldRetain(3, 2);

    assert.strictEqual(sampler.trackedConnections, 2);
    // Connection 1 was evicted, so it is sampled again; 3 is still inside its interval.
    assert.isTrue(sampler.shouldRetain(1, 3));
    assert.isFalse(sampler.shouldRetain(3, 4));
  });
});
