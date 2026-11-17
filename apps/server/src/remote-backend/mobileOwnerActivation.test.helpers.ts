import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { generateKeyPairSync } from "node:crypto";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { buildTestServerConfig } from "../server.test.app.config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { remoteClientAuthorizationLive } from "./clientRoutes.ts";
import {
  MobileConsentJournalError,
  RemoteMobileConsentJournal,
  type MobileConsentState,
} from "./mobileConsentEnable.ts";
import { RemoteMobileNativeInputsReport } from "./mobileGatewayActivation.inputs.ts";
import type { MobileNativeInputsReport } from "./mobileGatewayActivation.inputs.read.ts";
import {
  RemoteMobileGatewayActivation,
  RemoteMobileGatewayActivationLive,
  registeredMobileGatewayActivationState,
} from "./mobileGatewayActivation.service.ts";
import type { MobileActivationController } from "./mobileGatewayActivation.state.ts";
import { mobileOwnerActivationRoute } from "./mobileOwnerActivation.ts";
import { MOBILE_OWNER_ACTIVATION_PATH } from "./mobileOwnerActivation.protocol.ts";

export const ownerAuthority = "a".repeat(32);
export const activationHeaders = {
  authorization: "Bearer private-owner-fixture",
  "x-bigbud-client-rpc-revision": "1",
  "content-type": "application/json",
};
export function activationRequest(
  body: unknown,
  headers: Record<string, string> = activationHeaders,
) {
  return new Request(`http://owner.invalid${MOBILE_OWNER_ACTIVATION_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Real route, router authentication and activation service; journal and controller recorded. */
export async function makeOwnerActivationFixture(
  options: {
    remote?: boolean;
    consent?: MobileConsentState;
    inputs?: MobileNativeInputsReport;
    controller?: MobileActivationController;
  } = {},
) {
  const enables: number[] = [];
  let consent = options.consent ?? { enabled: false, revision: 2 };
  const config = Layer.effect(
    ServerConfig,
    buildTestServerConfig({
      config: {
        mode: options.remote === false ? "desktop" : "remote",
        authToken: "private-owner-fixture",
      },
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const settings = Layer.mock(ServerSettingsService)({
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
  });
  const identity = Layer.succeed(RemoteBackendIdentityService, {
    authority: {
      authorityId: ownerAuthority,
      keyFingerprint: `sha256:${"b".repeat(64)}`,
      keyEpoch: 1,
    },
    installationFingerprint: `sha256:${"c".repeat(64)}`,
    publicKey: generateKeyPairSync("ed25519").publicKey,
    signChallenge: () => {
      throw new Error("Not a signing endpoint");
    },
  });
  const journal = Layer.succeed(RemoteMobileConsentJournal, {
    read: Effect.sync(() => consent),
    enable: (expectedRevision: number) =>
      Effect.suspend(() => {
        enables.push(expectedRevision);
        if (expectedRevision !== consent.revision)
          return Effect.fail(new MobileConsentJournalError({ code: "stale" }));
        const changed = !consent.enabled;
        consent = { enabled: true, revision: consent.revision + (changed ? 1 : 0) };
        return Effect.succeed({ ...consent, changed });
      }),
  });
  const activation = await Effect.runPromise(
    Effect.service(RemoteMobileGatewayActivation).pipe(
      Effect.provide(RemoteMobileGatewayActivationLive),
    ),
  );
  if (options.controller)
    registeredMobileGatewayActivationState(activation).attach(options.controller);
  const services = Layer.mergeAll(
    config,
    settings,
    identity,
    journal,
    Layer.succeed(RemoteMobileGatewayActivation, activation),
    Layer.succeed(RemoteMobileNativeInputsReport, options.inputs ?? { kind: "absent" }),
  );
  const app = HttpRouter.toWebHandler(
    mobileOwnerActivationRoute.pipe(
      Layer.provide(remoteClientAuthorizationLive),
      HttpRouter.provideRequest(services),
      Layer.provide(config),
    ),
    { disableLogger: true },
  );
  return { ...app, enables, consent: () => consent };
}
