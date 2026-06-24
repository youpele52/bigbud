import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "./server.test.helpers.ts";

it.layer(serverTestLayer)("server router seam > mobile pairing http", (it) => {
  it.effect("returns 404 for an unknown mobile pairing id", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get("/api/mobile/pairing/pairing-missing");
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns pairing status from the mobile remote control service", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            getPairingStatus: () =>
              Effect.succeed({
                pairingId: "pairing-1",
                scope: "thread-control",
                expiresAt: "2026-06-24T12:00:00.000Z",
                enabled: true,
                available: true,
              }),
          },
        },
      });

      const response = yield* HttpClient.get("/api/mobile/pairing/pairing-1");
      assert.equal(response.status, 200);
      assert.deepEqual(yield* response.json, {
        pairingId: "pairing-1",
        scope: "thread-control",
        expiresAt: "2026-06-24T12:00:00.000Z",
        enabled: true,
        available: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects invalid pairing exchanges", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            exchangePairing: () => Effect.fail(new Error("invalid pairing")),
          },
        },
      });

      const url = yield* getHttpServerUrl("/api/mobile/pairing/pairing-1/exchange");
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            secret: "secret-1",
            label: "iphone",
          }),
        }),
      );
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("exchanges a pairing into a mobile session payload", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            exchangePairing: () =>
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

      const url = yield* getHttpServerUrl("/api/mobile/pairing/pairing-1/exchange");
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            secret: "secret-1",
            label: "iphone",
          }),
        }),
      );
      assert.equal(response.status, 200);
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly sessionId: string;
        readonly sessionToken: string;
        readonly scope: string;
        readonly expiresAt: string;
        readonly websocketUrl: string;
      };
      assert.deepEqual(
        {
          ...body,
          websocketUrl: "normalized",
        },
        {
          sessionId: "session-1",
          sessionToken: "token-1",
          scope: "thread-control",
          expiresAt: "2026-07-01T12:00:00.000Z",
          websocketUrl: "normalized",
        },
      );
      assert.include((body as { websocketUrl: string }).websocketUrl, "/mobile-ws?token=token-1");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns CORS headers for mobile pairing preflight requests", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: {
            getPairingStatus: () =>
              Effect.succeed({
                pairingId: "pairing-1",
                scope: "thread-control",
                expiresAt: "2026-06-24T12:00:00.000Z",
                enabled: true,
                available: true,
              }),
          },
        },
      });

      const url = yield* getHttpServerUrl("/api/mobile/pairing/pairing-1/exchange");
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "OPTIONS",
          headers: {
            "access-control-request-method": "POST",
            origin: "http://localhost:5740",
          },
        }),
      );
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.include(response.headers.get("access-control-allow-methods") ?? "", "POST");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
