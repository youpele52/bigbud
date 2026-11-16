import { buildRemoteAgentSupervisorObservation } from "./remoteAgentSupervisorLiveness.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentRegistryBuild } from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentInventory } from "./remoteAgentUpdate.inventory.ts";
import {
  advanceRemoteAgentRetirement,
  confirmRemoteAgentRetirementDeletion,
  recordRemoteAgentRetirementFailure,
  reserveRemoteAgentRetirement,
  tombstoneRemoteAgentRetirement,
} from "./remoteAgentInstall.registry.retirement.ts";
import { withdrawRemoteAgentPredecessor } from "./remoteAgentUpdate.state.ts";
import { reconcileRemoteAgentLaunchExits } from "./remoteAgentInstall.reconcile.ts";
import { remoteAgentBuildIsReferenced } from "./remoteAgentInstall.registry.references.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { buildRemoteAgentSupervisorShutdownCommand } from "./remoteAgentSupervisor.ts";
import { buildRemoteAgentRetirementDeletionCommand } from "./remoteAgentInstall.retirement.deletion.ts";
import type { RemoteAgentRetirementFence } from "./remoteAgentRetirement.ts";

type RetirementResult = "deleted" | "deferred";

async function markRetirementDeferred(
  control: RemoteAgentControl,
  reservationId: string,
  buildId: string,
): Promise<void> {
  try {
    await control.registry.update((state) => {
      const reservation = state.retirementReservations.find((entry) => entry.id === reservationId);
      if (reservation?.phase === "tombstoned") return state;
      if (reservation) {
        if (reservation.controllerId !== currentRemoteAgentController().id) return state;
        return advanceRemoteAgentRetirement(state, reservationId, "failed", "uncertain");
      }
      return recordRemoteAgentRetirementFailure(state, {
        id: reservationId,
        buildId,
        failure: "uncertain",
        controllerId: currentRemoteAgentController().id,
      });
    });
  } catch {
    // Retain the bytes and active fence if durable reconciliation is unavailable.
  }
}

async function retirementStillSafe(input: {
  readonly control: RemoteAgentControl;
  readonly buildId: string;
  readonly reservationId: string;
  readonly recheckReferencedBuildIds?: () => Promise<ReadonlySet<string>>;
}): Promise<boolean> {
  let state: Awaited<ReturnType<RemoteAgentControl["registry"]["read"]>>;
  try {
    state = await input.control.registry.read();
  } catch {
    return false;
  }
  const reservation = state.retirementReservations.find(
    (entry) => entry.id === input.reservationId,
  );
  if (
    !reservation ||
    reservation.buildId !== input.buildId ||
    reservation.phase === "failed" ||
    reservation.phase === "tombstoned" ||
    state.predecessor !== input.buildId ||
    remoteAgentBuildIsReferenced(state, input.buildId, { retirementId: input.reservationId })
  )
    return false;
  return externalReferencesStillSafe(input.buildId, input.recheckReferencedBuildIds);
}

async function externalReferencesStillSafe(
  buildId: string,
  recheck: (() => Promise<ReadonlySet<string>>) | undefined,
): Promise<boolean> {
  if (!recheck) return true;
  try {
    return !(await recheck()).has(buildId);
  } catch {
    return false;
  }
}

export async function probeRemoteAgentSupervisorState(
  control: RemoteAgentControl,
  runtime: ReturnType<typeof validateRemoteAgentRuntime>,
): Promise<"live" | "dead" | "uncertain" | "absent"> {
  const attemptId = (await control.registry.read()).launches.find(
    (entry) => entry.id === runtime.generation,
  )?.attemptId;
  if (!attemptId) {
    const state = `'${runtime.statePath.replaceAll("'", "'\\''")}'`;
    const result = await control.run(`set -eu
state=${state}
if test ! -e "$state" && test ! -L "$state" && test "$(readlink -m -- "$state")" = "$state"; then printf absent; else printf uncertain; fi
`);
    return result.trim() === "absent" ? "absent" : "uncertain";
  }
  const result = await control.run(`set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
case "$(observe_supervisor)" in
  ready|live) printf live ;;
  exited:*) printf dead ;;
  prior-boot-dead) printf dead ;;
  *) printf uncertain ;;
esac
`);
  return result.trim() === "live" ? "live" : result.trim() === "dead" ? "dead" : "uncertain";
}

async function awaitSupervisorExit(
  control: RemoteAgentControl,
  runtime: ReturnType<typeof validateRemoteAgentRuntime>,
): Promise<boolean> {
  const attemptId = (await control.registry.read()).launches.find(
    (entry) => entry.id === runtime.generation,
  )?.attemptId;
  if (!attemptId) return false;
  const result = await control.run(`set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
for n in $(seq 1 100); do
  case "$(observe_supervisor)" in exited:*|prior-boot-dead) printf exited; exit 0 ;; esac
  sleep .1
done
printf uncertain
`);
  return result.trim() === "exited";
}

async function proveRemoteAgentLaunchExit(
  control: RemoteAgentControl,
  buildId: string,
): Promise<void> {
  try {
    await reconcileRemoteAgentLaunchExits(control, { buildId });
  } catch {
    // Unproven exits keep the launch unresolved, which defers retirement conservatively.
  }
}

/** Retire one managed build through fencing, native control, and exact deletion. */
export async function retireManagedRemoteAgentBuild(input: {
  readonly control: RemoteAgentControl;
  readonly buildId: string;
  readonly reservationId: string;
  readonly referencedBuildIds?: ReadonlySet<string>;
  readonly recheckReferencedBuildIds?: () => Promise<ReadonlySet<string>>;
  readonly fence?: RemoteAgentRetirementFence;
  readonly beginRetirement?: (generation: string) => Promise<() => void>;
  readonly withdrawPredecessor?: boolean;
  readonly allowLiveShutdown?: boolean;
}): Promise<RetirementResult> {
  const before = await input.control.registry.read();
  const build = before.builds.find((entry) => entry.id === input.buildId);
  if (!build || build.binary !== "present" || build.runtime.origin !== "managed") return "deferred";
  if (input.referencedBuildIds?.has(input.buildId)) return "deferred";
  const runtime = validateRemoteAgentRuntime(build.runtime);
  // Only the explicit `--replace` predecessor path may reserve a build whose launch is still ready.
  const liveLaunch = input.allowLiveShutdown === true && input.withdrawPredecessor === true;
  let releaseFence: (() => void) | undefined;
  let deletionStarted = false;
  try {
    // A supervisor that already exited still has a `ready` launch until its exit receipt is proven.
    await proveRemoteAgentLaunchExit(input.control, input.buildId);
    if (input.allowLiveShutdown === false) {
      const observedState = await input.control.registry.read();
      if (
        observedState.launches.some(
          (launch) => launch.buildId === input.buildId && launch.phase === "ready",
        )
      )
        return "deferred"; // Policy forbids live retirement; this is not an uncertain attempt.
    }
    await input.control.registry.update((state) =>
      reserveRemoteAgentRetirement(state, {
        id: input.reservationId,
        buildId: input.buildId,
        controllerId: currentRemoteAgentController().id,
        ...(input.withdrawPredecessor ? { allowPredecessorReservation: true } : {}),
        ...(liveLaunch ? { allowLiveLaunch: true } : {}),
      }),
    );
    if (input.beginRetirement) releaseFence = await input.beginRetirement(runtime.generation);
    else if (input.fence) releaseFence = await input.fence.begin(runtime.generation);
    await input.control.registry.update((state) =>
      advanceRemoteAgentRetirement(state, input.reservationId, "fenced"),
    );
    const observed = await probeRemoteAgentSupervisorState(input.control, runtime);
    if (observed === "live") {
      if (input.allowLiveShutdown === false) {
        await markRetirementDeferred(input.control, input.reservationId, input.buildId);
        return "deferred";
      }
      await input.control.registry.update((state) =>
        advanceRemoteAgentRetirement(state, input.reservationId, "shutdown-requested"),
      );
      const result = await input.control.run(buildRemoteAgentSupervisorShutdownCommand(runtime));
      if (result.trim() !== "shutdown-accepted")
        throw new Error("Supervisor shutdown was not accepted.");
      if (!(await awaitSupervisorExit(input.control, runtime))) {
        await markRetirementDeferred(input.control, input.reservationId, input.buildId);
        return "deferred";
      }
    } else if (observed !== "dead" && observed !== "absent") {
      await markRetirementDeferred(input.control, input.reservationId, input.buildId);
      return "deferred";
    }
    if (input.withdrawPredecessor) {
      // Withdrawal requires the launch to be proven dead from its receipt, not just unreachable.
      await proveRemoteAgentLaunchExit(input.control, input.buildId);
      if (
        !(await retirementStillSafe({
          control: input.control,
          buildId: input.buildId,
          reservationId: input.reservationId,
          ...(input.recheckReferencedBuildIds
            ? { recheckReferencedBuildIds: input.recheckReferencedBuildIds }
            : {}),
        }))
      ) {
        await markRetirementDeferred(input.control, input.reservationId, input.buildId);
        return "deferred";
      }
      await input.control.registry.update((state) =>
        withdrawRemoteAgentPredecessor(state, input.reservationId, input.buildId),
      );
    }
    // Ordinary cleanup also needs the latest external service/owner references, not only
    // predecessor withdrawal. Unknown metadata retains the bytes and settles conservatively.
    if (!(await externalReferencesStillSafe(input.buildId, input.recheckReferencedBuildIds))) {
      await markRetirementDeferred(input.control, input.reservationId, input.buildId);
      return "deferred";
    }
    await input.control.registry.update((state) =>
      advanceRemoteAgentRetirement(state, input.reservationId, "exited"),
    );
    await input.control.registry.update((state) =>
      tombstoneRemoteAgentRetirement(state, input.reservationId),
    );
    deletionStarted = true;
    const deletion = await input.control.run(buildRemoteAgentRetirementDeletionCommand(runtime));
    if (deletion.trim() !== "deleted") {
      // Tombstones remain active until the exact unlink is reconciled.
      return "deferred";
    }
    await input.control.registry.update((state) =>
      confirmRemoteAgentRetirementDeletion(state, input.reservationId),
    );
    return "deleted";
  } catch (error) {
    if (!deletionStarted)
      await markRetirementDeferred(input.control, input.reservationId, input.buildId);
    if (deletionStarted) throw error;
    return "deferred";
  } finally {
    releaseFence?.();
  }
}

export type RemoteAgentPredecessorCapacityResult = "not-needed" | "reclaimed" | "deferred";

/** Reclaim the obsolete predecessor only when physical capacity and ownership are known. */
export async function prepareRemoteAgentPredecessorRetirement(input: {
  readonly target: string;
  readonly control: RemoteAgentControl;
  readonly build: RemoteAgentRegistryBuild;
  readonly inventory: RemoteAgentInventory;
  readonly referencedBuildIds?: () => Promise<ReadonlySet<string>>;
  readonly beginRetirement?: (generation: string) => Promise<() => void>;
}): Promise<RemoteAgentPredecessorCapacityResult> {
  if (
    input.inventory.uniqueDigests.has(input.build.runtime.sha256) ||
    input.inventory.uniqueDigests.size < 2
  )
    return "not-needed";
  if (
    input.inventory.noncompliant ||
    input.inventory.uncertain ||
    input.inventory.unknownOwner ||
    input.inventory.untracked
  )
    return "deferred";
  const state = await input.control.registry.read();
  const predecessorId = state.predecessor;
  if (!predecessorId || predecessorId === state.current) return "deferred";
  const predecessor = state.builds.find((entry) => entry.id === predecessorId);
  if (!predecessor || predecessor.runtime.origin !== "managed") return "deferred";
  if (!input.referencedBuildIds) return "deferred";
  let referencedBuildIds: ReadonlySet<string>;
  try {
    referencedBuildIds = await input.referencedBuildIds();
  } catch {
    return "deferred";
  }
  if (referencedBuildIds.has(predecessorId)) return "deferred";
  const result = await retireManagedRemoteAgentBuild({
    control: input.control,
    buildId: predecessorId,
    reservationId: `retire-update-${predecessor.runtime.generation}`,
    referencedBuildIds,
    ...(input.beginRetirement ? { beginRetirement: input.beginRetirement } : {}),
    withdrawPredecessor: true,
    allowLiveShutdown: false,
    recheckReferencedBuildIds: input.referencedBuildIds,
  });
  return result === "deleted" ? "reclaimed" : "deferred";
}
