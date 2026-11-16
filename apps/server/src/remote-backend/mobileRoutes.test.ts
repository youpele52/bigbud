import { Effect, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { ServerConfig } from "../startup/config.ts";
import { remoteMobileAuthorizationLive } from "./mobileRoutes.ts";

it("requires the separate gateway credential before current, future and unknown upstream handlers", async () => {
  let invoked = 0;
  const credential = "g".repeat(32);
  const config = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig;
      return {
        ...base,
        mode: "remote" as const,
        authToken: "c".repeat(32),
        remoteMobile: { gatewayCredential: Redacted.make(credential) },
      };
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/tmp/mobile-upstream-fixture", "/tmp/mobile-upstream-fixture").pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
  const routes = HttpRouter.add(
    "GET",
    "/future-route",
    Effect.sync(() => {
      invoked++;
      return HttpServerResponse.text("private upstream");
    }),
  ).pipe(Layer.provide(remoteMobileAuthorizationLive), Layer.provide(config));
  const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    for (const path of ["/future-route", "/api/mobile/handshake", "/mobile-ws", "/unknown"]) {
      for (const headers of [
        {},
        { authorization: `Bearer ${"c".repeat(32)}` },
        { "x-bigbud-mobile-gateway": "wrong" },
      ]) {
        expect(
          (await app.handler(new Request(`http://upstream.invalid${path}`, { headers }))).status,
        ).toBe(403);
      }
    }
    expect(invoked).toBe(0);
    const headers = { "x-bigbud-mobile-gateway": credential };
    expect(
      (await app.handler(new Request("http://upstream.invalid/future-route", { headers }))).status,
    ).toBe(200);
    expect(invoked).toBe(1);
    for (const path of ["/ws", "/api/internal/thread-tools", "/", "/mobile"]) {
      expect(
        (await app.handler(new Request(`http://upstream.invalid${path}`, { headers }))).status,
      ).toBe(404);
    }
  } finally {
    await app.dispose();
  }
});

it("keeps mobile capability false without a real lifecycle handoff even after application consent", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { DEFAULT_SERVER_SETTINGS } = await import("@bigbud/contracts/settings");
  const { ServerSettingsService } = await import("../ws/serverSettings.ts");
  const { RemoteBackendIdentityService } = await import("./identity.service.ts");
  const { makeRemoteMobileDescriptorRoute } = await import("./mobileRoutes.ts");
  const credential = "g".repeat(32);
  const config = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig;
      return {
        ...base,
        mode: "remote" as const,
        remoteMobile: { gatewayCredential: Redacted.make(credential) },
      };
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(
          "/tmp/mobile-descriptor-fixture",
          "/tmp/mobile-descriptor-fixture",
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  const { publicKey } = generateKeyPairSync("ed25519");
  const services = Layer.mergeAll(
    Layer.succeed(RemoteBackendIdentityService, {
      authority: {
        authorityId: "a".repeat(32),
        keyEpoch: 1,
        keyFingerprint: `sha256:${"b".repeat(64)}`,
      },
      installationFingerprint: `sha256:${"c".repeat(64)}`,
      publicKey,
      signChallenge: () => {
        throw new Error("Public descriptor cannot sign");
      },
    }),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        mobileRemoteControl: { ...DEFAULT_SERVER_SETTINGS.mobileRemoteControl, enabled: true },
      }),
    }),
  );
  const app = HttpRouter.toWebHandler(
    makeRemoteMobileDescriptorRoute("0.3.3").pipe(
      HttpRouter.provideRequest(services),
      Layer.provide(config),
    ),
    { disableLogger: true },
  );
  try {
    const response = await app.handler(
      new Request("http://upstream.invalid/api/mobile/handshake", {
        headers: { "x-bigbud-mobile-gateway": credential },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      mobileCapable: false,
      mobileRpcRevision: 1,
      authority: { authorityId: "a".repeat(32) },
    });
  } finally {
    await app.dispose();
  }
});
