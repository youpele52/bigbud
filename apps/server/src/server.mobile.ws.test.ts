import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@bigbud/contracts";
import { MOBILE_RECOVERY_WS_METHODS } from "@bigbud/contracts/server/mobile.recovery";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import {
  buildAppUnderTest,
  getWsServerUrl,
  makeDefaultOrchestrationReadModel,
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

  it.effect("fails mobile baseline availability without falling back to full snapshots", () =>
    Effect.gen(function* () {
      let fullSnapshotCalls = 0;
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
          projectionSnapshotQuery: {
            getSnapshot: () =>
              Effect.sync(() => {
                fullSnapshotCalls += 1;
                return makeDefaultOrchestrationReadModel();
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/mobile-ws?token=token-1");
      const result = yield* Effect.scoped(
        withRetriedMobileWsRpcClient(wsUrl, (client) =>
          client[MOBILE_RECOVERY_WS_METHODS.getBaseline]({
            recoveryAttemptId: "unavailable-baseline",
          }),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      assert.equal(fullSnapshotCalls, 0);
      if (result._tag === "Failure") {
        assert.include(String(result.failure), "MobileRecoveryBaselineError");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("binds mobile recovery to the baseline epoch and emits catch-up", () =>
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
          orchestrationEngine: {
            serverEpoch: "route-server-epoch",
            readReplay: (fromSequenceExclusive: number) =>
              Effect.succeed({
                requestedFromSequenceExclusive: fromSequenceExclusive,
                retainedFromSequenceExclusive: 0,
                earliestAvailableSequence: null,
                latestSequence: 0,
                availability: "available" as const,
                complete: true,
                events: [],
              }),
            openDeliveryLiveCapture: () =>
              Effect.succeed({
                stream: Stream.empty,
                isOverflowed: Effect.succeed(false),
                close: Effect.void,
              }),
          },
          projectionSnapshotQuery: {
            getMobileRecoveryBaseline: () =>
              Effect.succeed({
                snapshot: makeDefaultOrchestrationReadModel(),
                snapshotSequence: 0,
                selectedThread: null,
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/mobile-ws?token=token-1");
      const attemptId = "route-recovery-attempt";
      const frames = yield* Effect.scoped(
        withRetriedMobileWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const baseline = yield* client[MOBILE_RECOVERY_WS_METHODS.getBaseline]({
              recoveryAttemptId: attemptId,
            });
            const staleFrames = yield* Stream.runCollect(
              client[MOBILE_RECOVERY_WS_METHODS.subscribe]({
                recoveryAttemptId: attemptId,
                serverEpoch: "stale-server-epoch",
                baselineSequence: baseline.snapshotSequence,
              }),
            );
            const staleFrame = Array.from(staleFrames)[0];
            assert.equal(staleFrame?.type, "resync-required");
            if (staleFrame?.type === "resync-required") {
              assert.equal(staleFrame.reason, "invalid-cursor");
            }
            const stream = client[MOBILE_RECOVERY_WS_METHODS.subscribe]({
              recoveryAttemptId: attemptId,
              serverEpoch: baseline.serverEpoch,
              baselineSequence: baseline.snapshotSequence,
            });
            return yield* Stream.takeUntil(stream, (frame) => frame.type === "caught-up").pipe(
              Stream.runCollect,
            );
          }),
        ),
      );

      const collected = Array.from(frames);
      assert.isAtLeast(collected.length, 1);
      assert.equal(collected.at(-1)?.type, "caught-up");
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
