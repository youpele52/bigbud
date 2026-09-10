import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { CommandId } from "@bigbud/contracts/core/baseSchemas";
import { MOBILE_RECOVERY_WS_METHODS } from "@bigbud/contracts/server/mobile.recovery";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import {
  buildAppUnderTest,
  defaultThreadId,
  getWsServerUrl,
  serverTestLayer,
  wsRpcOpenRetrySchedule,
} from "./server.test.helpers.ts";

const makeClient = RpcClient.make(MobileWsRpcGroup);
type Client = typeof makeClient extends Effect.Effect<infer A, any, any> ? A : never;

const withClient = <A, E, R>(url: string, run: (client: Client) => Effect.Effect<A, E, R>) =>
  makeClient.pipe(
    Effect.flatMap(run),
    Effect.provide(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(NodeSocket.layerWebSocket(url)),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ),
    Effect.retry({
      schedule: wsRpcOpenRetrySchedule,
      times: 5,
      while: (error) => String(error).includes("SocketOpenError"),
    }),
  );

const session = {
  sessionId: "session-1",
  token: "token-1",
  scope: "thread-control" as const,
  createdAt: "2026-06-24T12:00:00.000Z",
  expiresAt: "2026-07-01T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  label: "iphone",
};

it.layer(serverTestLayer)("mobile command outcome seam", (it) => {
  it.effect("returns only a receipt matching the requested thread", () =>
    Effect.gen(function* () {
      let validationCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            validateSessionToken: () => {
              validationCalls += 1;
              return Effect.succeed(session);
            },
          },
          orchestrationEngine: {
            serverEpoch: "epoch-1",
            getCommandOutcome: (commandId) =>
              Effect.succeed({
                commandId,
                status: "accepted" as const,
                aggregateKind: "thread" as const,
                aggregateId: defaultThreadId,
                acceptedAt: "2026-06-24T12:00:00.000Z",
                resultSequence: 7,
                serverEpoch: "epoch-1",
                canonicalRevision: 7,
              }),
          },
        },
      });
      const response = yield* Effect.scoped(
        withClient(yield* getWsServerUrl("/mobile-ws?token=token-1"), (client) =>
          client[MOBILE_RECOVERY_WS_METHODS.getCommandOutcome]({
            commandId: CommandId.makeUnsafe("command-1"),
            threadId: defaultThreadId,
          }),
        ),
      );
      if (response.status !== "accepted") throw new Error("Expected an accepted outcome");
      assert.equal(validationCalls, 2);
      assert.equal(response.resultSequence, 7);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not disclose a receipt from another thread", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: { validateSessionToken: () => Effect.succeed(session) },
          orchestrationEngine: {
            serverEpoch: "epoch-1",
            getCommandOutcome: (commandId) =>
              Effect.succeed({
                commandId,
                status: "accepted" as const,
                aggregateKind: "thread" as const,
                aggregateId: "other-thread" as never,
                acceptedAt: "2026-06-24T12:00:00.000Z",
                resultSequence: 7,
                serverEpoch: "epoch-1",
                canonicalRevision: 7,
              }),
          },
        },
      });
      const response = yield* Effect.scoped(
        withClient(yield* getWsServerUrl("/mobile-ws?token=token-1"), (client) =>
          client[MOBILE_RECOVERY_WS_METHODS.getCommandOutcome]({
            commandId: CommandId.makeUnsafe("command-2"),
            threadId: defaultThreadId,
          }),
        ),
      );
      assert.equal(response.status, "unknown");
      assert.notProperty(response, "resultSequence");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
