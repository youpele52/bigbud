import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { buildAppUnderTest, getWsServerUrl, serverTestLayer } from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import { withMobileWsRpcClient, withRetriedMobileWsRpcClient } from "./server.test.mobile.ts";

const session = {
  sessionId: "session-1",
  token: "token-1",
  scope: "thread-control" as const,
  createdAt: "2026-06-24T12:00:00.000Z",
  expiresAt: "2099-07-01T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  label: "iphone",
};

it.layer(serverTestLayer)("server router seam > mobile session revocation", (it) => {
  it.effect("refuses to dispatch once the open socket's session is no longer valid", () =>
    Effect.gen(function* () {
      let dispatched = 0;
      let validations = 0;
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            // Valid for the upgrade, revoked by the time a command arrives.
            validateSessionToken: () => Effect.sync(() => (validations++ === 0 ? session : null)),
          },
          commandGateway: {
            dispatchNormalized: () =>
              Effect.sync(() => {
                dispatched += 1;
                return { sequence: 1 };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/mobile-ws?token=token-1");
      const result = yield* Effect.scoped(
        withRetriedMobileWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.interrupt",
            commandId: "cmd-interrupt-1",
            threadId: "thread-default",
            createdAt: "2026-06-24T12:00:00.000Z",
          } as never),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.include(JSON.stringify(result.failure), "Mobile session is no longer authorized");
      assert.equal(dispatched, 0);
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );

  it.effect("closes an open socket with 4503 when mobile remote control is turned off", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            validateSessionToken: () => Effect.succeed(session),
            watchSessionEnd: () => Effect.sleep("200 millis").pipe(Effect.as("disabled" as const)),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/mobile-ws?token=token-1");
      const result = yield* Effect.scoped(
        withMobileWsRpcClient(wsUrl, (client) =>
          Effect.sleep("600 millis").pipe(
            Effect.andThen(
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.turn.interrupt",
                commandId: "cmd-interrupt-2",
                threadId: "thread-default",
                createdAt: "2026-06-24T12:00:00.000Z",
              } as never),
            ),
          ),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      // Not an authorization close: the phone keeps its pairing.
      assert.include(JSON.stringify(result.failure), '"code":4503');
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
