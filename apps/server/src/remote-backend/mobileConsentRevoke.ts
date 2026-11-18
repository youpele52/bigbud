import { homedir } from "node:os";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import * as Data from "effect/Data";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsMobileConsentGuard } from "../ws/serverSettings.mobileConsent.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { loadRemoteBackendIdentity } from "./authority.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import { assertLocalSupervisorBackendReservation } from "./localSupervisorAuthority.ts";
import { readLocalSupervisorServiceFile } from "./localSupervisorService.files.ts";
import {
  MAX_REMOTE_AGENT_REGISTRY_BYTES,
  parseRemoteAgentRegistry,
} from "../remote-agent/remoteAgentInstall.registry.ts";
import { makeRemoteAgentRegistryStore } from "../remote-agent/remoteAgentInstall.registry.store.ts";
import { mobileRegistryOwnerEqual } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { setRemoteAgentMobileConsent } from "../remote-agent/remoteAgentInstall.mobile.transitions.ts";

class MobileConsentRevokeError extends Data.TaggedError("MobileConsentRevokeError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}
const unavailable = (cause: unknown) =>
  new MobileConsentRevokeError({
    message: "Remote mobile consent could not be revoked.",
    cause,
  });

export const RemoteMobileConsentGuardLive = Layer.effect(
  ServerSettingsMobileConsentGuard,
  Effect.gen(function* () {
    const owner = yield* BackendInstance;
    const identity = yield* RemoteBackendIdentityService;
    const config = yield* ServerConfig;
    const accountHome = homedir();
    if (config.mode !== "remote" || config.stateDir !== owner.stateDir)
      return yield* Effect.fail(unavailable("Remote backend ownership is required."));
    const pin = Object.freeze({
      authority: Object.freeze({ ...identity.authority }),
      installationFingerprint: identity.installationFingerprint,
    });
    const revoke = () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const abort = new AbortController();
          const completion = Promise.resolve().then(async () => {
            abort.signal.throwIfAborted();
            await owner.assertHeld();
            const homeDir = await fs.realpath(accountHome);
            const control = makeLocalSupervisorControl({
              homeDir,
              targetId: localSupervisorTarget(pin.authority.authorityId),
            });
            const path = join(control.root, "control-v1", "registry.json");
            let initial: ReturnType<typeof parseRemoteAgentRegistry>;
            try {
              initial = parseRemoteAgentRegistry(
                await readLocalSupervisorServiceFile(path, MAX_REMOTE_AGENT_REGISTRY_BYTES),
              );
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
              throw cause;
            }
            // Default-off and legacy base-only accounts need no mobile write or v3 migration.
            if (initial.schemaVersion !== 3) return;
            const assertOwner = async () => {
              await owner.assertHeld();
              const current = await loadRemoteBackendIdentity(owner, { requireExisting: true });
              if (!mobileRegistryOwnerEqual(pin, current))
                throw unavailable("Backend identity changed.");
              await assertLocalSupervisorBackendReservation(control, current, owner.stateDir);
              abort.signal.throwIfAborted();
            };
            await assertOwner();
            const store = makeRemoteAgentRegistryStore(control.root, {
              run: async (script) => {
                await assertOwner();
                const result = await control.run(control.targetId, script, {
                  signal: abort.signal,
                  timeoutMs: 15_000,
                  maxBufferBytes: 2 * 1024 * 1024,
                });
                await assertOwner();
                return result.stdout;
              },
            });
            await store.update((state) => {
              if (state.schemaVersion !== 3 || !mobileRegistryOwnerEqual(pin, state.mobile.owner))
                throw unavailable("Mobile authority or registry changed.");
              return setRemoteAgentMobileConsent(
                state,
                {
                  owner: pin,
                  expectedConsentRevision: state.mobile.consent.revision,
                },
                false,
              );
            });
            await assertOwner();
          });
          return { abort, completion };
        }),
        ({ abort, completion }) =>
          Effect.tryPromise({
            try: (signal) => {
              const cancel = () => abort.abort(signal.reason);
              signal.addEventListener("abort", cancel, { once: true });
              if (signal.aborted) cancel();
              return completion.finally(() => signal.removeEventListener("abort", cancel));
            },
            catch: unavailable,
          }),
        ({ abort, completion }) =>
          Effect.promise(async () => {
            abort.abort();
            await completion.then(
              () => {},
              () => {},
            );
          }),
      );
    return { revoke: Effect.suspend(revoke) };
  }),
);
