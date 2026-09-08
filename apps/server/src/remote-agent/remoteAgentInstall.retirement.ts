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
import { currentRemoteAgentController } from "./remoteAgentController.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { buildRemoteAgentSupervisorShutdownCommand } from "./remoteAgentSupervisor.ts";
import type { RemoteAgentRetirementFence } from "./remoteAgentRetirement.ts";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
    state.current === input.buildId ||
    state.predecessor !== input.buildId ||
    state.pins.some((pin) => pin.buildId === input.buildId) ||
    state.stages.some((stage) => stage.buildId === input.buildId && stage.phase !== "cancelled") ||
    state.launches.some(
      (launch) => launch.buildId === input.buildId && launch.phase !== "proven-dead",
    ) ||
    state.admissions.some((admission) => admission.buildId === input.buildId)
  )
    return false;
  if (input.recheckReferencedBuildIds) {
    try {
      if ((await input.recheckReferencedBuildIds()).has(input.buildId)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function supervisorState(
  control: RemoteAgentControl,
  runtime: ReturnType<typeof validateRemoteAgentRuntime>,
): Promise<"live" | "dead" | "uncertain" | "absent"> {
  const command = [
    "set -eu",
    `state=${quote(runtime.statePath)}`,
    `socket=${quote(runtime.socketPath)}`,
    'if test -S "$socket"; then printf live; exit 0; fi',
    'if test ! -e "$state"; then printf absent; exit 0; fi',
    'if test -f "$state/launch.exit" && test -f "$state/launch.lock"; then',
    '  exec 8< "$state/launch.lock"',
    "  if flock -n -x 8; then printf dead; else printf uncertain; fi",
    "else",
    "  printf uncertain",
    "fi",
  ].join("\n");
  return (await control.run(command)).trim() as "live" | "dead" | "uncertain" | "absent";
}

async function awaitSupervisorExit(
  control: RemoteAgentControl,
  runtime: ReturnType<typeof validateRemoteAgentRuntime>,
): Promise<boolean> {
  const command = [
    "set -eu",
    `state=${quote(runtime.statePath)}`,
    `socket=${quote(runtime.socketPath)}`,
    "for n in $(seq 1 100); do",
    '  if test ! -S "$socket" && test -f "$state/launch.exit" && test -f "$state/launch.lock"; then',
    '    exec 8< "$state/launch.lock"',
    "    if flock -n -x 8; then printf exited; exit 0; fi",
    "  fi",
    "  sleep .1",
    "done",
    "printf uncertain",
  ].join("\n");
  return (await control.run(command)).trim() === "exited";
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
  let releaseFence: (() => void) | undefined;
  let deletionStarted = false;
  try {
    await input.control.registry.update((state) =>
      reserveRemoteAgentRetirement(state, {
        id: input.reservationId,
        buildId: input.buildId,
        controllerId: currentRemoteAgentController().id,
        ...(input.withdrawPredecessor ? { allowPredecessorReservation: true } : {}),
      }),
    );
    if (input.beginRetirement) releaseFence = await input.beginRetirement(runtime.generation);
    else if (input.fence) releaseFence = await input.fence.begin(runtime.generation);
    await input.control.registry.update((state) =>
      advanceRemoteAgentRetirement(state, input.reservationId, "fenced"),
    );
    const observed = await supervisorState(input.control, runtime);
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
    await input.control.registry.update((state) =>
      advanceRemoteAgentRetirement(state, input.reservationId, "exited"),
    );
    await input.control.registry.update((state) =>
      tombstoneRemoteAgentRetirement(state, input.reservationId),
    );
    deletionStarted = true;
    const deletion = await input.control.run(
      [
        "set -eu",
        `binary=${quote(runtime.binaryPath)}`,
        'directory=$(dirname -- "$binary")',
        'test "$(readlink -m -- "$binary")" = "$binary"',
        'if test -e "$binary" || test -L "$binary"; then',
        '  test ! -L "$binary"',
        '  test -f "$binary"',
        '  test "$(stat -c \'%u\' -- "$binary")" = "$(id -u)"',
        '  test "$(stat -c \'%a\' -- "$binary")" = 700',
        `  test "$(sha256sum -- "$binary" | cut -d ' ' -f1)" = '${runtime.sha256}'`,
        '  sync -f "$directory"',
        '  rm -- "$binary"',
        '  sync -f "$directory"',
        "fi",
        'test ! -e "$binary"',
        'test ! -L "$binary"',
        'sync -f "$directory"',
        "printf deleted",
      ].join("\n"),
    );
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
