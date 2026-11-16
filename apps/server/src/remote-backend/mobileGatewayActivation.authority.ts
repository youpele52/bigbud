import { homedir } from "node:os";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import * as Data from "effect/Data";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { loadRemoteBackendIdentity } from "./authority.ts";
import { assertLocalSupervisorBackendReservation } from "./localSupervisorAuthority.ts";
import { assertLocalSupervisorServiceDirectory } from "./localSupervisorService.files.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import { mobileRegistryOwnerEqual } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { makeRemoteAgentRegistryStore } from "../remote-agent/remoteAgentInstall.registry.store.ts";

class MobileActivationAuthorityError extends Data.TaggedError("MobileActivationAuthorityError")<{
  readonly message: string;
}> {}
const unavailable = () =>
  new MobileActivationAuthorityError({
    message:
      "Activation requires the existing locked Linux remote backend and claimed account authority.",
  });

/** Lease-free control context only. It grants no publication/process/readiness authority. */
export const acquireMobileGatewayActivationAuthority = Effect.gen(function* () {
  const owner = yield* BackendInstance;
  const identity = yield* RemoteBackendIdentityService;
  const config = yield* ServerConfig;
  if (
    process.platform !== "linux" ||
    config.mode !== "remote" ||
    config.stateDir !== owner.stateDir ||
    owner.pid !== process.pid ||
    !owner.startedAt ||
    owner.lockPath !== join(owner.stateDir, "backend.lock")
  )
    return yield* Effect.fail(unavailable());
  const homeDir = yield* Effect.promise(() => fs.realpath(homedir()));
  const pin = Object.freeze({
    authority: Object.freeze({ ...identity.authority }),
    installationFingerprint: identity.installationFingerprint,
  });
  const control = makeLocalSupervisorControl({
    homeDir,
    targetId: localSupervisorTarget(pin.authority.authorityId),
  });
  const assertAuthority = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    await owner.assertHeld();
    await assertLocalSupervisorServiceDirectory(owner.stateDir);
    const current = await loadRemoteBackendIdentity(owner, { requireExisting: true });
    if (!mobileRegistryOwnerEqual(pin, current)) throw unavailable();
    await assertLocalSupervisorBackendReservation(control, current, owner.stateDir);
    await owner.assertHeld();
    signal?.throwIfAborted();
  };
  yield* Effect.tryPromise(() => assertAuthority());
  const registry = (signal: AbortSignal) =>
    makeRemoteAgentRegistryStore(control.root, {
      run: async (script) => {
        await assertAuthority(signal);
        const result = await control.run(control.targetId, script, {
          signal,
          timeoutMs: 15_000,
          maxBufferBytes: 2 * 1024 * 1024,
        });
        await assertAuthority(signal);
        return result.stdout;
      },
    });
  return Object.freeze({ owner, pin, assertAuthority, registry });
});
export type MobileGatewayActivationAuthority = Effect.Success<
  typeof acquireMobileGatewayActivationAuthority
>;
