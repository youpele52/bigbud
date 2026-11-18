/**
 * End-to-end: restarting the mobile gateway drops open sockets but loses no
 * session. The gateway holds no state, so the phone reconnects through the
 * replacement with the same token and reads again without re-pairing.
 * Runs only when `BIGBUD_MOBILE_GATEWAY_BIN` points at a built gateway.
 */
import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

import {
  EXTERNAL_HOST,
  GATEWAY_BIN,
  fetchEffect,
  realMobileRemoteControl,
  startGateway,
  withGatewayCredential,
} from "./server.mobile.gateway.fixtures.ts";
import {
  buildAppUnderTest,
  getWsServerUrl,
  makeDefaultOrchestrationReadModel,
  serverTestLayer,
} from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import { withMobileWsRpcClient } from "./server.test.mobile.ts";

it.layer(serverTestLayer)("server router seam > mobile gateway restart", (it) => {
  it.effect.skipIf(!GATEWAY_BIN)(
    "keeps the paired session across a gateway restart on the same port",
    () =>
      Effect.gen(function* () {
        const credential = yield* withGatewayCredential;
        const mobile = yield* realMobileRemoteControl;
        yield* buildAppUnderTest({
          layers: {
            mobileRemoteControl: mobile,
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
        const backendPort = Number(new URL(yield* getWsServerUrl("/")).port);

        // First gateway, in its own scope so it can be stopped mid-test.
        const firstScope = yield* Scope.make();
        // Also closed on early failure, so the first gateway never outlives the test.
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
        const first = yield* startGateway(backendPort, credential).pipe(Scope.provide(firstScope));
        const listen = `127.0.0.1:${first.port}`;
        const pairing = yield* mobile.createPairing({
          scope: "thread-control",
          baseUrl: `https://${EXTERNAL_HOST}/mobile`,
          backendBaseUrl: `https://${EXTERNAL_HOST}`,
        });
        const exchange = yield* fetchEffect(
          `http://${listen}/api/mobile/pairing/${pairing.pairingId}/exchange`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ secret: pairing.secret, label: "gateway-restart" }),
          },
        );
        assert.equal(exchange.status, 200);
        const { sessionToken } = JSON.parse(exchange.body) as { sessionToken: string };
        const wsUrl = `ws://${listen}/mobile-ws?token=${encodeURIComponent(sessionToken)}`;

        // The open socket fails once its gateway is gone.
        const acrossStop = yield* Effect.scoped(
          withMobileWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              yield* client[ORCHESTRATION_WS_METHODS.getSnapshot]({});
              yield* Scope.close(firstScope, Exit.void);
              return yield* client[ORCHESTRATION_WS_METHODS.getSnapshot]({}).pipe(
                Effect.timeout("5 seconds"),
                Effect.result,
              );
            }),
          ),
        );
        assert.equal(acrossStop._tag, "Failure");

        // A replacement on the same port serves the same session; no re-pairing.
        yield* startGateway(backendPort, credential, listen);
        const afterRestart = yield* Effect.scoped(
          withMobileWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.getSnapshot]({}),
          ),
        );
        assert.isAtLeast(afterRestart.threads.length, 1);
        const sessions = yield* mobile.listSessions;
        assert.equal(sessions.filter((session) => session.revokedAt === null).length, 1);
      }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
