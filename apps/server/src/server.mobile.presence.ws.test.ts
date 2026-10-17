import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EventId, ThreadId, WS_METHODS, type OrchestrationEvent } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { desktopSupervisorDeliveryTestCoordinator } from "./desktop-supervisor/desktopSupervisorDelivery.testLayer.ts";
import { buildAppUnderTest, getWsServerUrl, serverTestLayer } from "./server.test.helpers.ts";
import { withRetriedMobileWsRpcClient } from "./server.test.mobile.ts";

it.layer(serverTestLayer)("server router seam > mobile presence", (it) => {
  // M5: the mobile client has no model-choice picker, so it must not hold a delegated first turn.
  it.effect("does not count a mobile domain-event subscriber as an interactive client", () =>
    Effect.gen(function* () {
      const observed: boolean[] = [];
      const archived: OrchestrationEvent = {
        sequence: 1,
        eventId: EventId.makeUnsafe("mobile-presence-event"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-default"),
        occurredAt: "2026-10-15T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.archived",
        payload: {
          threadId: ThreadId.makeUnsafe("thread-default"),
          archivedAt: "2026-10-15T00:00:00.000Z",
          updatedAt: "2026-10-15T00:00:00.000Z",
        },
      };
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
            readEvents: () => Stream.make(archived),
            serverEpoch: "mobile-presence-epoch",
            streamDomainEvents: Stream.never,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/mobile-ws?token=token-1");
      const frames = yield* Effect.scoped(
        withRetriedMobileWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeOrchestrationDomainEvents]({}).pipe(
            // Probed while the server-side subscription is still open.
            Stream.tap(() =>
              Effect.sync(() =>
                observed.push(desktopSupervisorDeliveryTestCoordinator.hasOpenConsumer()),
              ),
            ),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      assert.lengthOf(Array.from(frames), 1);
      assert.deepStrictEqual(observed, [false]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
