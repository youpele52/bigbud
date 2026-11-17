import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { compareRemoteBackendIdentity } from "@bigbud/shared/remoteBackendIdentity";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { withMobilePublicationOwner } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { BootstrapCommandLockService } from "../ws/wsBootstrap.lock.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileGatewayOwner } from "./mobileGatewayOwner.service.ts";

export class MobileGatewayListenerError extends Data.TaggedError("MobileGatewayListenerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
export const mobileGatewayListenerUnavailable = (cause?: unknown) =>
  new MobileGatewayListenerError({
    message: "The private mobile gateway listener could not complete.",
    cause,
  });

/**
 * Shared listener validation prefix for the Node listener and the native session. It reuses this
 * backend's actual RPC services/boot lock and validates the original publication owner read-only;
 * it must precede the first socket side effect. No credential or configuration escapes.
 */
export const validateMobileGatewayListener = Effect.fn("validateMobileGatewayListener")(function* (
  proof: VerifiedMobilePublication,
) {
  const config = yield* ServerConfig;
  const owner = yield* BackendInstance;
  const identity = yield* RemoteBackendIdentityService;
  const settings = yield* ServerSettingsService;
  const gateway = yield* RemoteMobileGatewayOwner;
  // This must be the same acquired service as client/callback runtime consumers.
  yield* BootstrapCommandLockService;
  const onSnapshotChange = settings.onSnapshotChange;
  const assertAllowed = async () => {
    await owner.assertHeld();
    if (!settings.currentSnapshot?.()?.settings.mobileRemoteControl.enabled)
      throw mobileGatewayListenerUnavailable();
  };
  if (
    config.mode !== "remote" ||
    config.stateDir !== owner.stateDir ||
    config.remoteMobile ||
    !settings.currentSnapshot ||
    !settings.withSnapshotBarrier ||
    !onSnapshotChange
  )
    return yield* mobileGatewayListenerUnavailable();
  // Read-only original capability/owner validation precedes the first socket side effect.
  yield* Effect.tryPromise({
    try: (signal) =>
      withMobilePublicationOwner(
        proof,
        async ({ authority, paths }) => {
          if (
            authority.owner.nonce !== owner.nonce ||
            authority.owner.stateDir !== owner.stateDir ||
            authority.owner.lockPath !== owner.lockPath ||
            authority.owner.pid !== owner.pid ||
            authority.owner.startedAt !== owner.startedAt ||
            compareRemoteBackendIdentity(paths.owner, identity) !== "match"
          )
            throw mobileGatewayListenerUnavailable();
          await assertAllowed();
        },
        signal,
      ),
    catch: mobileGatewayListenerUnavailable,
  });
  return Object.freeze({ config, owner, gateway, assertAllowed, onSnapshotChange });
});
