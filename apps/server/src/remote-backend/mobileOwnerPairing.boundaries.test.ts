import { unrelatedGatewayServices } from "./mobileOwnerPairing.boundaryServices.ts";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import { RemoteCallbackRoutesLive } from "../server.remote.callbacks.ts";
import { makeRemoteMobileRoutesLayer } from "./mobileRoutes.ts";
import { ServerConfig } from "../startup/config.ts";
import { BootstrapCommandLockLive } from "../ws/wsBootstrap.lock.ts";
import { parseRemoteAgentControlRequest } from "../remote-agent/remoteAgentLocalControl.protocol.ts";
import { MOBILE_OWNER_PAIRING_PATH } from "./mobileOwnerPairing.protocol.ts";
import { ownerHeaders, ownerInput } from "./mobileOwnerPairing.test.helpers.ts";
it("never adds pairing issuance to the D1 installation-control method allowlist", () => {
  for (const method of ["pair", "mobile.pair", "mobilePairing", "createMobileRemotePairing"])
    expect(parseRemoteAgentControlRequest({ v: 1, method, target: "fixture" })).toMatchObject({
      unsupported: true,
    });
});
it("keeps the owner-only issuance endpoint absent from actual gateway and callback route layers", async () => {
  const base = ServerConfig.layerTest(
    "/tmp/mobile-owner-boundary",
    "/tmp/mobile-owner-boundary",
  ).pipe(Layer.provide(NodeServices.layer));
  const config = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const prior = yield* ServerConfig;
      return {
        ...prior,
        mode: "remote" as const,
        authToken: "private-owner-fixture",
        remoteMobile: { gatewayCredential: Redacted.make("g".repeat(32)) },
      };
    }).pipe(Effect.provide(base)),
  );
  for (const routes of [
    RemoteCallbackRoutesLive,
    makeRemoteMobileRoutesLayer("fixture").pipe(Layer.provide(BootstrapCommandLockLive)),
  ]) {
    const app = HttpRouter.toWebHandler(
      routes.pipe(
        HttpRouter.provideRequest(
          Layer.mergeAll(config, unrelatedGatewayServices, NodeServices.layer),
        ),
        Layer.provide(config),
      ),
      { disableLogger: true },
    );
    try {
      const response = await app.handler(
        new Request(`http://private.invalid${MOBILE_OWNER_PAIRING_PATH}`, {
          method: "POST",
          headers: { ...ownerHeaders, "x-bigbud-mobile-gateway": "g".repeat(32) },
          body: JSON.stringify(ownerInput),
        }),
      );
      expect(response.status).toBe(404);
    } finally {
      await app.dispose();
    }
  }
});
