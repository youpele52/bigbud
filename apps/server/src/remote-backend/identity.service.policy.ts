import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import type { RemoteBackendIdentity } from "./authority.ts";
import { RemoteBackendAuthorityError } from "./authority.record.ts";
import {
  makeRemoteBackendIdentityLive,
  RemoteBackendIdentityLive,
  RemoteBackendIdentityService,
} from "./identity.service.ts";

type IdentityPin = Pick<RemoteBackendIdentity, "authority" | "installationFingerprint">;
// An in-process handoff policy, never a persisted authority or an environment-based trust claim.
const servicePolicies = new WeakMap<ServerConfigShape, IdentityPin>();

export function bindAccountServiceIdentity(config: ServerConfigShape, identity: IdentityPin) {
  if (config.mode !== "remote" || servicePolicies.has(config))
    throw new Error("Account service identity policy requires an unbound remote configuration.");
  servicePolicies.set(
    config,
    Object.freeze({
      authority: Object.freeze({
        authorityId: identity.authority.authorityId,
        keyEpoch: identity.authority.keyEpoch,
        keyFingerprint: identity.authority.keyFingerprint,
      }),
      installationFingerprint: identity.installationFingerprint,
    }),
  );
  return config;
}

/** Main startup reacquires the lock and revalidates the exact preflight identity before SQL. */
export const RemoteBackendIdentityForServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const expected = servicePolicies.get(config);
    if (!expected) return RemoteBackendIdentityLive;
    return Layer.effect(
      RemoteBackendIdentityService,
      Effect.gen(function* () {
        const identity = yield* RemoteBackendIdentityService;
        if (
          identity.authority.authorityId !== expected.authority.authorityId ||
          identity.authority.keyEpoch !== expected.authority.keyEpoch ||
          identity.authority.keyFingerprint !== expected.authority.keyFingerprint ||
          identity.installationFingerprint !== expected.installationFingerprint
        )
          return yield* Effect.fail(
            new RemoteBackendAuthorityError(
              "installation-changed",
              "The account service identity changed after preflight; preserve and inspect the installation.",
            ),
          );
        return identity;
      }),
    ).pipe(Layer.provide(makeRemoteBackendIdentityLive({ requireExisting: true })));
  }),
);
