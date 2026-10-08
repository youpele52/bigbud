import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { buildAppUnderTest } from "./server.test.app.ts";
import { getWsServerUrl, serverTestLayer, withRetriedWsRpcClient } from "./server.test.rpc.ts";

it.layer(serverTestLayer)("server websocket retry clock", (it) => {
  it.effect(
    "recovers from an initial socket-open failure without advancing a test clock",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();
        const wsUrl = yield* getWsServerUrl("/ws");
        let attempts = 0;
        const snapshot = yield* Effect.scoped(
          withRetriedWsRpcClient(wsUrl, (client) => {
            attempts += 1;
            // Force the retry branch that real handshake failures reach under load.
            return attempts === 1
              ? Effect.fail(new Error("SocketOpenError: first connection failed"))
              : client[ORCHESTRATION_WS_METHODS.getSnapshot]({});
          }),
        );

        assert.equal(attempts, 2);
        assert.isAtLeast(snapshot.threads.length, 1);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    2000,
  );

  it.effect("still bounds socket-open retries and preserves other errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const socketFailure = new Error("SocketOpenError: connection failed");
      let attempts = 0;
      const exhausted = yield* Effect.scoped(
        withRetriedWsRpcClient(wsUrl, () => {
          attempts += 1;
          return Effect.fail(socketFailure);
        }).pipe(Effect.result),
      );
      assert.equal(attempts, 6);
      assert.equal(exhausted._tag, "Failure");
      if (exhausted._tag === "Failure") assert.strictEqual(exhausted.failure, socketFailure);

      const rpcFailure = new Error("RPC handler failed");
      attempts = 0;
      const failed = yield* Effect.scoped(
        withRetriedWsRpcClient(wsUrl, () => {
          attempts += 1;
          return Effect.fail(rpcFailure);
        }).pipe(Effect.result),
      );
      assert.equal(attempts, 1);
      assert.equal(failed._tag, "Failure");
      if (failed._tag === "Failure") assert.strictEqual(failed.failure, rpcFailure);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
