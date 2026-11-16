import { Effect, Layer, Schema } from "effect";
import { RemoteBackendClientHandshake } from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../startup/config.ts";
import { makeRemoteClientHandshakeRoute, remoteClientAuthorizationLive } from "./clientRoutes.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { generateKeyPairSync } from "node:crypto";

describe("remote client router authentication boundary", () => {
  it("serves only the authenticated public client identity with truthful unavailable capabilities", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const config = ServerConfig.layerTest("/tmp/handshake-fixture", "/tmp/handshake-fixture").pipe(
      Layer.provide(NodeServices.layer),
    );
    const configured = Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const base = yield* ServerConfig;
        return { ...base, authToken: "fixture-secret" };
      }).pipe(Effect.provide(config)),
    );
    const app = HttpRouter.toWebHandler(
      makeRemoteClientHandshakeRoute("1.0.0").pipe(
        HttpRouter.provideRequest(
          Layer.succeed(RemoteBackendIdentityService, {
            authority: {
              authorityId: "a".repeat(32),
              keyEpoch: 1,
              keyFingerprint: `sha256:${"b".repeat(64)}`,
            },
            installationFingerprint: `sha256:${"c".repeat(64)}`,
            publicKey,
            signChallenge: () => {
              throw new Error("Handshake must not expose a signer.");
            },
          }),
        ),
        Layer.provide(configured),
      ),
      { disableLogger: true },
    );
    try {
      const url = "http://remote.invalid/api/remote-backend/handshake";
      expect((await app.handler(new Request(url))).status).toBe(401);
      const response = await app.handler(
        new Request(url, { headers: { authorization: "Bearer fixture-secret" } }),
      );
      expect(response.status).toBe(200);
      const value = Schema.decodeUnknownSync(RemoteBackendClientHandshake)(await response.json());
      expect(value.authority).toEqual({
        authorityId: "a".repeat(32),
        keyEpoch: 1,
        keyFingerprint: `sha256:${"b".repeat(64)}`,
      });
      expect(Object.values(value.capabilities)).toEqual([false, false, false, false, false, false]);
      expect(Object.keys(value).toSorted()).toEqual([
        "authority",
        "backendVersion",
        "capabilities",
        "clientRpcRevision",
        "handshakeRevision",
        "installationFingerprint",
      ]);
    } finally {
      await app.dispose();
    }
  });

  it("guards current, future, and unknown HTTP routes before any handler executes", async () => {
    let invoked = 0;
    const routes = HttpRouter.add(
      "GET",
      "/attachment",
      Effect.sync(() => {
        invoked++;
        return HttpServerResponse.text("private attachment");
      }),
    ).pipe(Layer.provide(remoteClientAuthorizationLive));
    const config = Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const base = yield* ServerConfig;
        return { ...base, mode: "remote" as const, authToken: "fixture-secret" };
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest("/tmp/fixture", "/tmp/fixture").pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
    const app = HttpRouter.toWebHandler(routes.pipe(Layer.provide(config)), {
      disableLogger: true,
    });
    try {
      for (const path of ["/attachment", "/unknown", "/ws", "/api/mobile/pairing/new"]) {
        const response = await app.handler(new Request(`http://remote.invalid${path}`));
        expect(response.status).toBe(401);
      }
      expect(invoked).toBe(0);
      const incompatible = await app.handler(
        new Request("http://remote.invalid/attachment", {
          headers: { authorization: "Bearer fixture-secret" },
        }),
      );
      expect(incompatible.status).toBe(426);
      expect(invoked).toBe(0);
      const response = await app.handler(
        new Request("http://remote.invalid/attachment", {
          headers: { authorization: "Bearer fixture-secret", "x-bigbud-client-rpc-revision": "1" },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("private attachment");
      expect(invoked).toBe(1);
    } finally {
      await app.dispose();
    }
  });
});
