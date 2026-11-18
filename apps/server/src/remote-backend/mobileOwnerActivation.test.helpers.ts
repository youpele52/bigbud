import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { generateKeyPairSync } from "node:crypto";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@bigbud/contracts/settings";
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
import { mobileNativeInputsSummary } from "./mobileGatewayActivation.inputs.ts";
import type { MobileNativeInputsReport } from "./mobileGatewayActivation.inputs.read.ts";
import {
  RemoteMobileGatewayActivation,
  RemoteMobileGatewayActivationLive,
  registeredMobileGatewayActivationState,
} from "./mobileGatewayActivation.service.ts";
import type { MobileActivationController } from "./mobileGatewayActivation.state.ts";
import { mobileOwnerActivationRoute } from "./mobileOwnerActivation.ts";
import { makeMobileOwnerActivationRoutes } from "./mobileOwnerActivation.routes.ts";
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

/**
 * Real route composition (request-scoped journal), router authentication, activation service and
 * attach-time inputs recording; journal, settings and controller are recorded. App-wide services
 * never include the journal or the inputs report: `legacy` wires the journal the pre-fix way
 * (`Layer.provide` on the route layer) as a negative control.
 */
export async function makeOwnerActivationFixture(
  options: {
    remote?: boolean;
    consent?: MobileConsentState;
    inputs?: MobileNativeInputsReport;
    controller?: MobileActivationController;
    settingsEnabled?: boolean;
    legacy?: boolean;
  } = {},
) {
  const enables: number[] = [];
  let consent = options.consent ?? { enabled: false, revision: 2 };
  let currentSettings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    mobileRemoteControl: {
      ...DEFAULT_SERVER_SETTINGS.mobileRemoteControl,
      enabled: options.settingsEnabled ?? false,
    },
  };
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
    getSettings: Effect.sync(() => currentSettings),
    updateSettings: (patch) =>
      Effect.sync(() => {
        currentSettings = {
          ...currentSettings,
          mobileRemoteControl: {
            ...currentSettings.mobileRemoteControl,
            ...patch.mobileRemoteControl,
          },
        };
        return currentSettings;
      }),
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
  // What the attach layer records from its single inputs read (never app-wide provision).
  registeredMobileGatewayActivationState(activation).recordInputs(
    mobileNativeInputsSummary(options.inputs ?? { kind: "absent" }),
  );
  if (options.controller)
    registeredMobileGatewayActivationState(activation).attach(options.controller);
  const services = Layer.mergeAll(
    config,
    settings,
    identity,
    Layer.succeed(RemoteMobileGatewayActivation, activation),
  );
  const route = options.legacy
    ? mobileOwnerActivationRoute.pipe(Layer.provide(journal))
    : makeMobileOwnerActivationRoutes(journal);
  const app = HttpRouter.toWebHandler(
    route.pipe(
      Layer.provide(remoteClientAuthorizationLive),
      HttpRouter.provideRequest(services),
      Layer.provide(config),
    ),
    { disableLogger: true },
  );
  return {
    ...app,
    enables,
    consent: () => consent,
    settingsEnabled: () => currentSettings.mobileRemoteControl.enabled,
  };
}
