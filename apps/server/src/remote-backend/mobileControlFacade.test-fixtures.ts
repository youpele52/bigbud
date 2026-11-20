import { generateKeyPairSync } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as ServiceMap from "effect/ServiceMap";
import { ServerConfig } from "../startup/config.ts";
import { BackendInstance, type BackendInstanceShape } from "../startup/backendInstance.ts";
import { buildTestServerConfig } from "../server.test.app.config.ts";
import { makeTestSettings } from "../ws/serverSettings.testing.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../ws/serverSettings.ts";
import {
  MobileRemoteControl,
  type MobileRemoteControlShape,
} from "../mobile/Services/MobileRemoteControl.ts";
import {
  mobileAdmissionStampEqual,
  type RemoteMobileAdmissionStamp,
} from "../mobile/Services/MobileRemoteControlAdmission.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import { RemoteMobileControlFacadeLive } from "./mobileControlFacade.ts";

export const fixtureAdmission: RemoteMobileAdmissionStamp = {
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  consentRevision: 1,
  backendExternalOrigin: "https://fixture.ts.net",
};

/** Real file-backed service; readiness/committed consent are explicitly synthetic injected data. */
export function mobileFacadeFixture(
  options: {
    admission?: boolean;
    status?: boolean;
    legacyReadyOnly?: boolean;
    barrier?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const config = yield* buildTestServerConfig({ config: { mode: "remote" } });
    const initialSettings = yield* makeTestSettings({ mobileRemoteControl: { enabled: true } });
    const { withSnapshotBarrier, ...withoutBarrier } = initialSettings;
    const settings: ServerSettingsShape =
      options.barrier === false ? withoutBarrier : { ...withoutBarrier, withSnapshotBarrier };
    const changes = yield* PubSub.unbounded<"revoked" | "disabled">();
    const state: { stamp: RemoteMobileAdmissionStamp | null; ready: boolean; reads: number } = {
      stamp: options.admission === false ? null : structuredClone(fixtureAdmission),
      ready: true,
      reads: 0,
    };
    const owner: BackendInstanceShape = {
      nonce: "fixture-backend",
      pid: process.pid,
      startedAt: "fixture-process",
      hostname: "fixture",
      machineId: "fixture-machine",
      stateDir: config.stateDir,
      lockPath: `${config.stateDir}/backend.lock`,
      assertHeld: async () => {},
      classifyOwner: () => "dead",
    };
    const identity = {
      authority: fixtureAdmission.authority,
      installationFingerprint: fixtureAdmission.installationFingerprint,
      publicKey: generateKeyPairSync("ed25519").publicKey,
      signChallenge: () => {
        throw new Error("Fixture does not sign challenges");
      },
    };
    const status = {
      ready: Effect.sync(() => state.ready),
      verifiedExternalOrigin: fixtureAdmission.backendExternalOrigin,
      ...(options.legacyReadyOnly
        ? {}
        : {
            readAdmission: () =>
              Effect.sync(() => {
                state.reads += 1;
                return state.stamp;
              }),
            watchAdmissionEnd: (stamp: RemoteMobileAdmissionStamp) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(changes);
                  if (!state.stamp || !mobileAdmissionStampEqual(stamp, state.stamp))
                    return "revoked" as const;
                  if (!state.ready) return "disabled" as const;
                  return yield* PubSub.take(subscription);
                }),
              ),
          }),
    };
    const services = Layer.mergeAll(
      Layer.succeed(ServerConfig, config),
      Layer.succeed(ServerSettingsService, settings),
      Layer.succeed(BackendInstance, owner),
      Layer.succeed(RemoteBackendIdentityService, identity),
      ...(options.status === false ? [] : [Layer.succeed(RemoteMobileGatewayStatus, status)]),
    );
    const layer = RemoteMobileControlFacadeLive.pipe(Layer.provide(services));
    const build = Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      return ServiceMap.get(context, MobileRemoteControl);
    });
    const mobile = yield* build;
    return {
      mobile,
      config,
      settings,
      state,
      rebuild: build,
      notify: (reason: "revoked" | "disabled") => PubSub.publish(changes, reason),
    };
  });
}

export function pairUsing(mobile: MobileRemoteControlShape) {
  return Effect.gen(function* () {
    const pairing = yield* mobile.createPairing({
      scope: "thread-control",
      baseUrl: fixtureAdmission.backendExternalOrigin,
      backendBaseUrl: fixtureAdmission.backendExternalOrigin,
    });
    const session = yield* mobile.exchangePairing({
      pairingId: pairing.pairingId,
      secret: pairing.secret,
      label: "fixture-phone",
    });
    return { pairing, session };
  });
}
