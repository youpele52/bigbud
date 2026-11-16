/**
 * End-to-end seam: a real mobile pairing, exchange, WebSocket session and
 * revocation through the Rust mobile gateway binary, against an isolated
 * backend (temporary state, no live account). Runs only when
 * `BIGBUD_MOBILE_GATEWAY_BIN` points at a built gateway.
 */
import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

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

it.layer(serverTestLayer)("server router seam > mobile gateway end to end", (it) => {
  it.effect.skipIf(!GATEWAY_BIN)(
    "pairs, connects, enforces the credential and honors revocation",
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
        const backendUrl = new URL(yield* getWsServerUrl("/"));
        const gateway = yield* startGateway(Number(backendUrl.port), credential);
        const viaGateway = `http://127.0.0.1:${gateway.port}`;
        const pairing = yield* mobile.createPairing({
          scope: "thread-control",
          baseUrl: `https://${EXTERNAL_HOST}/mobile`,
          backendBaseUrl: `https://${EXTERNAL_HOST}`,
        });

        // The backend refuses mobile routes that did not come through the gateway.
        const direct = yield* fetchEffect(
          `http://127.0.0.1:${backendUrl.port}/api/mobile/pairing/${pairing.pairingId}`,
        );
        assert.equal(direct.status, 403);
        const forged = yield* fetchEffect(
          `http://127.0.0.1:${backendUrl.port}/api/mobile/pairing/${pairing.pairingId}`,
          {
            headers: { "x-bigbud-mobile-gateway": "forged" },
          },
        );
        assert.equal(forged.status, 403);

        const status = yield* fetchEffect(`${viaGateway}/api/mobile/pairing/${pairing.pairingId}`);
        assert.equal(status.status, 200);
        assert.equal((JSON.parse(status.body) as { available: boolean }).available, true);
        const exchange = yield* fetchEffect(
          `${viaGateway}/api/mobile/pairing/${pairing.pairingId}/exchange`,
          {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://mobile.bigbud.app" },
            body: JSON.stringify({ secret: pairing.secret, label: "gateway-e2e" }),
          },
        );
        assert.equal(exchange.status, 200);
        const session = JSON.parse(exchange.body) as {
          sessionId: string;
          sessionToken: string;
          websocketUrl: string;
        };
        // The backend saw the gateway's trusted origin, not the loopback hop.
        assert.equal(session.websocketUrl.split("/mobile-ws")[0], `wss://${EXTERNAL_HOST}`);

        const wsUrl = `ws://127.0.0.1:${gateway.port}/mobile-ws?token=${encodeURIComponent(session.sessionToken)}`;
        // Probe: does revocation reach a socket that is already open?
        const openSocketAfterRevoke = yield* Effect.scoped(
          withMobileWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const snapshot = yield* client[ORCHESTRATION_WS_METHODS.getSnapshot]({});
              assert.isAtLeast(snapshot.threads.length, 1);
              yield* mobile.revokeSession(session.sessionId);
              return yield* client[ORCHESTRATION_WS_METHODS.getSnapshot]({}).pipe(Effect.result);
            }),
          ),
        );
        assert.equal(openSocketAfterRevoke._tag, "Failure");
        // An explicit authorization close, passed through the gateway unchanged.
        assert.include(
          String(openSocketAfterRevoke._tag === "Failure" && openSocketAfterRevoke.failure),
          '"code":4401',
        );

        // A reused pairing secret is refused, and revocation blocks new sessions.
        const reused = yield* fetchEffect(
          `${viaGateway}/api/mobile/pairing/${pairing.pairingId}/exchange`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ secret: pairing.secret, label: "again" }),
          },
        );
        assert.equal(reused.status, 401);
        yield* mobile.revokeSession(session.sessionId);
        const afterRevoke = yield* Effect.scoped(
          withMobileWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.getSnapshot]({}),
          ).pipe(Effect.result),
        );
        assert.equal(afterRevoke._tag, "Failure");
      }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
