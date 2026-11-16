import { makeLocalSupervisorAuthorityOwners } from "./localSupervisorOwners.ts";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";

import { PtyAdapter, type PtyAdapterShape } from "../terminal/Services/PTY.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { RemoteAgentRuntimeOwnersLive } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteTerminalAvailability } from "./terminalAvailability.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { makeLocalSupervisorInstaller } from "./localSupervisorInstaller.ts";
import { makeLocalSupervisorPty } from "./localSupervisorPty.ts";
import { connectLocalSupervisorProxy } from "./localSupervisorTransport.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import { assertLocalSupervisorAuthorityReservation } from "./localSupervisorAuthority.ts";
import { verifyManagedLocalSupervisor } from "./localSupervisorBinary.ts";
import { RemoteUnavailablePtyLive } from "./unavailable.host.ts";
import type { RemoteAgentControl } from "../remote-agent/remoteAgentControl.ts";

class LocalSupervisorAdoptionError extends Error {
  readonly _tag = "LocalSupervisorAdoptionError";
}
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new LocalSupervisorAdoptionError(
        "The managed local supervisor is unavailable; existing terminals were not replaced.",
      ),
  });

/** Re-adoption only. Setup and independent account-service launch are separate authorized operations. */
export const RemoteLocalSupervisorPtyLive = Layer.unwrap(
  Effect.gen(function* () {
    const identityOption = yield* Effect.serviceOption(RemoteBackendIdentityService);
    const owners = yield* RemoteAgentRuntimeOwners;
    const availabilityOption = yield* Effect.serviceOption(RemoteTerminalAvailability);
    if (Option.isNone(identityOption) || Option.isNone(availabilityOption))
      return yield* Effect.fail(
        new LocalSupervisorAdoptionError(
          "Remote terminal composition requires the owning backend identity and readiness scope.",
        ),
      );
    const identity = identityOption.value;
    const availability = availabilityOption.value;
    const targetId = localSupervisorTarget(identity.authority.authorityId);
    const home = yield* attempt(() => fs.realpath(homedir()));
    const retained = yield* attempt(() => owners.getBinding(targetId));
    const retainedOwners = yield* attempt(
      async () => (await owners.listTerminalOwners?.(targetId, "", 1))?.owners.length ?? 0,
    );
    const retainedState = Boolean(retained) || retainedOwners > 0;
    const rootExists = yield* attempt(async () => {
      try {
        await fs.lstat(join(home, ".bigbud", "agent"));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    // A missing installation is not permission to create account state or start a supervisor.
    if (!rootExists && !retainedState) return RemoteUnavailablePtyLive;

    const control = makeLocalSupervisorControl({ targetId, homeDir: home });
    const assertAccountAuthority = async () => {
      if (!rootExists)
        throw new LocalSupervisorAdoptionError(
          "The retained supervisor installation is missing; preserve its ownership for repair.",
        );
      await assertLocalSupervisorAuthorityReservation(control, identity);
    };
    const reserved = rootExists
      ? yield* attempt(assertAccountAuthority).pipe(Effect.option)
      : Option.none();
    if (!retainedState && Option.isNone(reserved)) return RemoteUnavailablePtyLive;
    const openControl = async () => {
      await assertAccountAuthority();
      const opened = await control.openControl(targetId);
      return {
        ...opened,
        run: async (command: string) => {
          await assertAccountAuthority();
          return opened.run(command);
        },
        registry: {
          read: async () => {
            await assertAccountAuthority();
            return opened.registry.read();
          },
          update: async (change: Parameters<RemoteAgentControl["registry"]["update"]>[0]) => {
            await assertAccountAuthority();
            return opened.registry.update(change);
          },
        },
      };
    };
    const registry: RemoteAgentControl["registry"] = {
      read: async () => (await openControl()).registry.read(),
      update: async (change) => (await openControl()).registry.update(change),
    };
    const installer = makeLocalSupervisorInstaller({
      control: {
        ...control,
        openControl: async (target) => {
          if (target !== targetId)
            throw new LocalSupervisorAdoptionError("The supervisor belongs to another authority.");
          return openControl();
        },
        run: async (...args) => {
          await assertAccountAuthority();
          return control.run(...args);
        },
      },
    });
    const authorityOwners = makeLocalSupervisorAuthorityOwners({
      owners,
      targetId,
      assertAuthority: assertAccountAuthority,
    });
    const admission = installer.createAdmission(authorityOwners, async (target, runtime) => {
      if (target !== targetId)
        throw new LocalSupervisorAdoptionError("The supervisor belongs to another authority.");
      await assertAccountAuthority();
      return connectLocalSupervisorProxy(runtime);
    });
    const selected = rootExists
      ? yield* attempt(() => registry.read()).pipe(Effect.option)
      : undefined;
    if (
      !retainedState &&
      (selected === undefined || selected._tag === "None" || !selected.value.current)
    )
      return RemoteUnavailablePtyLive;

    const local = yield* Effect.acquireRelease(
      Effect.sync(() =>
        makeLocalSupervisorPty({
          authorityId: identity.authority.authorityId,
          owners: authorityOwners,
          registry,
          transport: {
            verifyRuntime: async (runtime) => {
              await assertAccountAuthority();
              await verifyManagedLocalSupervisor(runtime);
            },
          },
          resolveBinding: async () => {
            if (!rootExists)
              throw new LocalSupervisorAdoptionError(
                "The retained supervisor installation is missing.",
              );
            await assertAccountAuthority();
            return admission.resolveBinding(targetId);
          },
        }),
      ),
      (local) => Effect.sync(local.close),
    );
    const ready = yield* attempt(async () => {
      if (!rootExists || Option.isNone(reserved)) return false;
      const binding = await admission.resolveBinding(targetId);
      if (!binding) return false;
      await admission.verify(targetId, binding.runtime, binding.expectedEpoch);
      await local.runtime.pool.getBound(targetId, binding, [
        "terminal.pty",
        "terminal.pty-inventory",
        "terminal.shell-profiles",
        "workspace.files",
      ]);
      return true;
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (ready) yield* availability.markAvailable;
    else
      yield* Effect.logWarning(
        "Local supervisor adoption is unavailable; durable terminal ownership is retained.",
      );
    return Layer.succeed(PtyAdapter, local.adapter satisfies PtyAdapterShape);
  }),
).pipe(Layer.provide(RemoteAgentRuntimeOwnersLive));
