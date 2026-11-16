import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { generateKeyPairSync } from "node:crypto";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { MobileRemoteControl } from "../mobile/Services/MobileRemoteControl.ts";
import { MobileRemoteControlLive } from "../mobile/Layers/MobileRemoteControl.ts";
import { buildTestServerConfig } from "../server.test.app.config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import { remoteClientAuthorizationLive } from "./clientRoutes.ts";
import { mobileOwnerPairingRoute } from "./mobileOwnerPairing.ts";
export const ownerInput = {
  authorityId: "a".repeat(32),
  scope: "approve-only" as const,
  backendOrigin: "https://fixture.ts.net",
};
export const ownerHeaders = {
  authorization: "Bearer private-owner-fixture",
  "x-bigbud-client-rpc-revision": "1",
  "content-type": "application/json",
};
export function makeOwnerPairingFixture(
  options: {
    remote?: boolean;
    consent?: boolean;
    gateway?: "absent" | boolean;
    enabledConfig?: boolean;
    realMobile?: boolean;
    serviceError?: boolean;
    verifiedOrigin?: string | null;
  } = {},
) {
  let issued = 0;
  const config = Layer.effect(
    ServerConfig,
    buildTestServerConfig({
      config: {
        mode: options.remote === false ? "desktop" : "remote",
        authToken: "private-owner-fixture",
        ...(options.enabledConfig === false
          ? {}
          : { remoteMobile: { gatewayCredential: Redacted.make("g".repeat(32)) } }),
      },
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const settings = Layer.mock(ServerSettingsService)({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      mobileRemoteControl: {
        ...DEFAULT_SERVER_SETTINGS.mobileRemoteControl,
        enabled: options.consent !== false,
      },
    }),
  });
  const identity = Layer.succeed(RemoteBackendIdentityService, {
    authority: {
      authorityId: ownerInput.authorityId,
      keyFingerprint: `sha256:${"b".repeat(64)}`,
      keyEpoch: 1,
    },
    installationFingerprint: `sha256:${"c".repeat(64)}`,
    publicKey: generateKeyPairSync("ed25519").publicKey,
    signChallenge: () => {
      throw new Error("Not a signing endpoint");
    },
  });
  const mocked = Layer.mock(MobileRemoteControl)({
    createPairing: (input) =>
      Effect.sync(() => {
        issued++;
        if (options.serviceError) throw new Error("PRIVATE_TOKEN_MUST_NOT_ECHO");
        return {
          pairingId: "fixture-pair",
          scope: input.scope,
          expiresAt: "2099-01-01T00:00:00Z",
          secret: "fixture-secret",
          pairUrl: `${input.baseUrl}/mobile/pair/fixture-pair?backend=${encodeURIComponent(input.backendBaseUrl)}#secret=fixture-secret`,
        };
      }),
  });
  const mobile = options.realMobile
    ? MobileRemoteControlLive.pipe(Layer.provide(Layer.mergeAll(config, settings)))
    : mocked;
  const services = Layer.mergeAll(
    config,
    settings,
    identity,
    mobile,
    ...(options.gateway === "absent"
      ? []
      : [
          Layer.succeed(RemoteMobileGatewayStatus, {
            ready: Effect.succeed(options.gateway !== false),
            ...(options.verifiedOrigin === null
              ? {}
              : { verifiedExternalOrigin: options.verifiedOrigin ?? ownerInput.backendOrigin }),
          }),
        ]),
  );
  const app = HttpRouter.toWebHandler(
    mobileOwnerPairingRoute.pipe(
      Layer.provide(remoteClientAuthorizationLive),
      HttpRouter.provideRequest(services),
      Layer.provide(config),
    ),
    { disableLogger: true },
  );
  return { ...app, issued: () => issued };
}
