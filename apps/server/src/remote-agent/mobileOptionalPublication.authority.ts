import { homedir } from "node:os";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import * as Data from "effect/Data";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteBackendIdentityService } from "../remote-backend/identity.service.ts";
import { loadRemoteBackendIdentity } from "../remote-backend/authority.ts";
import { assertLocalSupervisorBackendReservation } from "../remote-backend/localSupervisorAuthority.ts";
import { mobileOptionalPublicationHost } from "./mobileOptionalPublication.host.ts";
import { assertLocalSupervisorServiceDirectory } from "../remote-backend/localSupervisorService.files.ts";
import { makeLocalSupervisorControl } from "../remote-backend/localSupervisorControl.ts";
import { localSupervisorTarget } from "../remote-backend/localSupervisorIdentity.ts";
import { verifyManagedLocalSupervisor } from "../remote-backend/localSupervisorBinary.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { mobileRegistryOwnerEqual } from "./remoteAgentInstall.mobile.schema.ts";
import type { MobileStageContext } from "./remoteAgentInstall.mobile.transitions.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

const registered = new WeakSet<object>();
const owners = new Map<string, object>();
class MobilePublicationOwnerError extends Data.TaggedError("MobilePublicationOwnerError")<{
  readonly message: string;
}> {}

/** Only service acquisition constructs this context; no renderer owner/root fields are accepted. */
export const acquireMobilePublicationAuthority = Effect.gen(function* () {
  const owner = Object.freeze({ ...(yield* BackendInstance) });
  const identity = yield* RemoteBackendIdentityService;
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  if (
    process.platform !== "linux" ||
    config.mode !== "remote" ||
    config.stateDir !== owner.stateDir ||
    owner.pid !== process.pid ||
    !owner.startedAt ||
    !settings.currentSnapshot ||
    !settings.onSnapshotChange ||
    owner.lockPath !== join(owner.stateDir, "backend.lock")
  ) {
    return yield* Effect.fail(
      new MobilePublicationOwnerError({
        message: "Mobile publication requires the live Linux remote backend owner.",
      }),
    );
  }
  const home = yield* Effect.promise(() => fs.realpath(homedir()));
  const control = makeLocalSupervisorControl({
    targetId: localSupervisorTarget(identity.authority.authorityId),
    homeDir: home,
  });
  const pin = Object.freeze({
    authority: Object.freeze({ ...identity.authority }),
    installationFingerprint: identity.installationFingerprint,
  });
  const controller = Object.freeze({ id: owner.nonce, pid: owner.pid, startedAt: owner.startedAt });
  const assertAuthority = async () => {
    await owner.assertHeld();
    await assertLocalSupervisorServiceDirectory(owner.stateDir);
    const current = await loadRemoteBackendIdentity(owner, { requireExisting: true });
    if (!mobileRegistryOwnerEqual(pin, current))
      throw new Error("Mobile publication backend identity changed.");
    await assertLocalSupervisorBackendReservation(control, current, owner.stateDir);
    await owner.assertHeld();
  };
  yield* Effect.tryPromise(assertAuthority);
  const enabled = async () => {
    if (!(await Effect.runPromise(settings.getSettings)).mobileRemoteControl.enabled)
      throw new Error("Mobile publication consent settings are disabled.");
  };
  function registry(signal?: AbortSignal) {
    return makeRemoteAgentRegistryStore(control.root, {
      run: async (script) => {
        signal?.throwIfAborted();
        await assertAuthority();
        const result = await control.run(control.targetId, script, {
          timeoutMs: 15_000,
          maxBufferBytes: 2 * 1024 * 1024,
          ...(signal ? { signal } : {}),
        });
        await assertAuthority();
        return result.stdout;
      },
    });
  }
  const context = (
    state: RemoteAgentRegistry,
    expectedConsentRevision: number,
    gateway: MobileOptionalArtifact,
    trustedKeys: Readonly<Record<string, string>>,
  ): MobileStageContext => {
    if (
      state.schemaVersion !== 3 ||
      !mobileRegistryOwnerEqual(state.mobile.owner, pin) ||
      !state.mobile.consent.enabled ||
      state.mobile.consent.revision !== expectedConsentRevision
    ) {
      throw new Error("Mobile publication requires current owner and consent revision.");
    }
    const host = mobileOptionalPublicationHost(state, gateway);
    return {
      owner: pin,
      controller,
      controllerHost: Object.freeze({ hostname: owner.hostname, machineId: owner.machineId }),
      expectedConsentRevision,
      trustedKeys,
      host,
    };
  };
  const inspect = async (
    expectedConsentRevision: number,
    gateway: MobileOptionalArtifact,
    trustedKeys: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    verifyBinary = true,
  ) => {
    signal?.throwIfAborted();
    await enabled();
    const store = registry(signal);
    const state = await store.read();
    const current = context(state, expectedConsentRevision, gateway, trustedKeys);
    const build = state.builds.find((entry) => entry.id === state.current)!;
    if (verifyBinary) await verifyManagedLocalSupervisor(build.runtime);
    await assertAuthority();
    signal?.throwIfAborted();
    return { store, state, context: current };
  };
  const result = Object.freeze({
    root: control.root,
    owner,
    pin,
    controller,
    assertAuthority,
    enabled,
    registry,
    context,
    inspect,
    subscribe: settings.onSnapshotChange?.bind(settings),
  });
  const ownerKey = `${owner.stateDir}\0${owner.nonce}`;
  if (owners.has(ownerKey) || owners.size >= 16)
    return yield* Effect.fail(
      new MobilePublicationOwnerError({
        message: "The backend already owns a mobile publisher lease, or owner capacity is full.",
      }),
    );
  owners.set(ownerKey, result);
  registered.add(result);
  return result;
});
export type MobilePublicationAuthority = Effect.Success<typeof acquireMobilePublicationAuthority>;

export function assertMobilePublicationAuthority(value: MobilePublicationAuthority): void {
  if (!registered.has(value))
    throw new Error("Mobile publication requires original live service authority.");
}
export function retireMobilePublicationAuthority(value: MobilePublicationAuthority): void {
  registered.delete(value);
}
/** Only after every accepted job settles; invalidation alone must not admit a second writer. */
export function releaseMobilePublicationAuthority(value: MobilePublicationAuthority): void {
  registered.delete(value);
  const key = `${value.owner.stateDir}\0${value.owner.nonce}`;
  if (owners.get(key) === value) owners.delete(key);
}

/** Cleanup capability only: retired launch authority may still own unsettled child/file work. */
export function assertMobilePublicationLease(value: MobilePublicationAuthority): void {
  const key = `${value.owner.stateDir}\0${value.owner.nonce}`;
  if (owners.get(key) !== value)
    throw new Error("Original mobile publisher lease is no longer held.");
}
