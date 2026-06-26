import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@bigbud/contracts";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import {
  buildAppUnderTest,
  getWsServerUrl,
  serverTestLayer,
  wsRpcOpenRetrySchedule,
} from "./server.test.helpers.ts";

const makeMobileWsRpcClient = RpcClient.make(MobileWsRpcGroup);
type MobileWsRpcClient =
  typeof makeMobileWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const mobileWsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson),
  );

const withMobileWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: MobileWsRpcClient) => Effect.Effect<A, E, R>,
) => makeMobileWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(mobileWsRpcProtocolLayer(wsUrl)));

const withRetriedMobileWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: MobileWsRpcClient) => Effect.Effect<A, E, R>,
) =>
  withMobileWsRpcClient(wsUrl, f).pipe(
    Effect.retry({
      schedule: wsRpcOpenRetrySchedule,
      times: 5,
      while: (error) => String(error).includes("SocketOpenError"),
    }),
  );

it.layer(serverTestLayer)("server router seam > mobile websocket auth", (it) => {
  it.effect("rejects mobile websocket handshake when token is missing", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/mobile-ws");
      const result = yield* Effect.scoped(
        withMobileWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getSnapshot]({}),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.include(String(result.failure), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects mobile websocket handshake when the session token is invalid", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/mobile-ws?token=bad-token");
      const result = yield* Effect.scoped(
        withMobileWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getSnapshot]({}),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.include(String(result.failure), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts a valid mobile session token for orchestration snapshot reads", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            validateSessionToken: () =>
              Effect.succeed({
                sessionId: "session-1",
                token: "token-1",
                scope: "thread-control",
                createdAt: "2026-06-24T12:00:00.000Z",
                expiresAt: "2026-07-01T12:00:00.000Z",
                lastUsedAt: null,
                revokedAt: null,
                label: "iphone",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/mobile-ws?token=token-1");
      const response = yield* Effect.scoped(
        withRetriedMobileWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getSnapshot]({}),
        ),
      );

      assert.isAtLeast(response.threads.length, 1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects disallowed orchestration commands on the mobile websocket", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            validateSessionToken: () =>
              Effect.succeed({
                sessionId: "session-1",
                token: "token-1",
                scope: "thread-control",
                createdAt: "2026-06-24T12:00:00.000Z",
                expiresAt: "2026-07-01T12:00:00.000Z",
                lastUsedAt: null,
                revokedAt: null,
                label: "iphone",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/mobile-ws?token=token-1");
      const result = yield* Effect.scoped(
        withRetriedMobileWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.unarchive",
            commandId: "cmd-unarchive-1",
            threadId: "thread-default",
            createdAt: "2026-06-24T12:00:00.000Z",
          } as never),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.include(String(result.failure), "OrchestrationDispatchCommandError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("streams server config snapshot to the mobile websocket", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            validateSessionToken: () =>
              Effect.succeed({
                sessionId: "session-1",
                token: "token-1",
                scope: "thread-control",
                createdAt: "2026-06-24T12:00:00.000Z",
                expiresAt: "2026-07-01T12:00:00.000Z",
                lastUsedAt: null,
                revokedAt: null,
                label: "iphone",
              }),
          },
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.empty,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/mobile-ws?token=token-1");
      const events = yield* Effect.scoped(
        withRetriedMobileWsRpcClient(wsUrl, (client) =>
          Stream.take(client[WS_METHODS.subscribeServerConfig]({}), 1).pipe(Stream.runCollect),
        ),
      );

      const snapshot = Array.from(events)[0];
      assert.isNotNull(snapshot);
      if (!snapshot || snapshot.type !== "snapshot") {
        return;
      }
      assert.equal(snapshot.config.providers.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
