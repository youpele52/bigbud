import { generateKeyPairSync } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RemoteAgentRuntimeOwnersLive } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { profileOwner } from "../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";

export const localSupervisorTestTarget = localSupervisorTarget("a".repeat(32));
export const localSupervisorTestIdentity = {
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  publicKey: generateKeyPairSync("ed25519").publicKey,
  signChallenge: () => new Uint8Array(),
};
export const localSupervisorTestIdentityLayer = Layer.succeed(
  RemoteBackendIdentityService,
  localSupervisorTestIdentity,
);
export function seedLocalSupervisorBinding() {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const owners = yield* RemoteAgentRuntimeOwners;
      const owner = profileOwner();
      yield* Effect.promise(() =>
        owners.bindConnection(localSupervisorTestTarget, "retained", {
          runtime: owner.runtime,
          expectedEpoch: owner.epoch,
        }),
      );
    }),
  ).pipe(Layer.provideMerge(RemoteAgentRuntimeOwnersLive));
}
