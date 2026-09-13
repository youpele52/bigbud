import type {
  RemoteAgentRegistry,
  RemoteAgentRegistryBuild,
  RemoteAgentRetirementReservation,
} from "./remoteAgentInstall.registry.ts";
import { confirmRemoteAgentRetirementDeletion } from "./remoteAgentInstall.registry.retirement.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { buildRemoteAgentRetirementDeletionCommand } from "./remoteAgentInstall.retirement.deletion.ts";
import { probeRemoteAgentSupervisorState } from "./remoteAgentInstall.retirement.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";

export const MAX_RETIREMENT_RECONCILIATIONS = 8;
const ACTIVE_UPDATE_PHASES: ReadonlySet<string> = new Set([
  "waiting-for-capacity",
  "reserved",
  "installing",
  "checking",
  "ready-for-reconnect",
  "uncertain",
] as const);
// Slot rows are immutable replay evidence; confirmation releases matching rows.

function registryReferencesBuild(
  state: RemoteAgentRegistry,
  buildId: string,
  reservationId: string,
): boolean {
  return (
    state.current === buildId ||
    state.predecessor === buildId ||
    state.pending === buildId ||
    state.pins.some((pin) => pin.buildId === buildId) ||
    state.stages.some((stage) => stage.buildId === buildId && stage.phase !== "cancelled") ||
    state.launches.some((launch) => launch.buildId === buildId && launch.phase !== "proven-dead") ||
    state.admissions.some((admission) => admission.buildId === buildId) ||
    // The matching update is the retirement's own durable evidence; an active
    // unrelated update still protects the build from continuation.
    state.updates.some(
      (update) =>
        update.buildId === buildId &&
        update.requestId !== reservationId &&
        ACTIVE_UPDATE_PHASES.has(update.phase),
    ) ||
    state.retirementReservations.some(
      (reservation) =>
        reservation.id !== reservationId &&
        reservation.buildId === buildId &&
        reservation.phase !== "failed",
    ) ||
    state.restartReservations.some(
      (reservation) => reservation.buildId === buildId && reservation.phase !== "failed",
    )
  );
}

function candidateMatches(
  state: RemoteAgentRegistry,
  reservation: RemoteAgentRetirementReservation,
): RemoteAgentRegistryBuild | undefined {
  if (reservation.phase !== "tombstoned") return undefined;
  const build = state.builds.find((entry) => entry.id === reservation.buildId);
  if (
    !build ||
    build.runtime.origin !== "managed" ||
    build.binary !== "deleting" ||
    build.runtime.generation !== reservation.generation ||
    registryReferencesBuild(state, build.id, reservation.id)
  )
    return undefined;
  return build;
}

async function readExternalReferences(
  referencedBuildIds: (() => Promise<ReadonlySet<string>>) | undefined,
): Promise<ReadonlySet<string> | undefined> {
  if (!referencedBuildIds) return new Set<string>();
  try {
    return await referencedBuildIds();
  } catch {
    return undefined;
  }
}

async function reconcileRetirementTombstone(input: {
  readonly control: RemoteAgentControl;
  readonly reservation: RemoteAgentRetirementReservation;
  readonly referencedBuildIds?: () => Promise<ReadonlySet<string>>;
}): Promise<boolean> {
  let state: RemoteAgentRegistry;
  try {
    state = await input.control.registry.read();
  } catch {
    return false;
  }
  const reservation = state.retirementReservations.find(
    (entry) => entry.id === input.reservation.id,
  );
  const build = reservation ? candidateMatches(state, reservation) : undefined;
  if (!reservation || !build) return false;

  const beforeReferences = await readExternalReferences(input.referencedBuildIds);
  if (!beforeReferences || beforeReferences.has(build.id)) return false;

  const beforeProbe = await input.control.registry.read();
  const probeReservation = beforeProbe.retirementReservations.find(
    (entry) => entry.id === reservation.id,
  );
  const probeBuild = probeReservation ? candidateMatches(beforeProbe, probeReservation) : undefined;
  if (!probeReservation || !probeBuild) return false;
  const runtime = validateRemoteAgentRuntime(probeBuild.runtime);
  let observed: "live" | "dead" | "uncertain" | "absent";
  try {
    observed = await probeRemoteAgentSupervisorState(input.control, runtime);
  } catch {
    return false;
  }
  if (observed !== "dead" && observed !== "absent") return false;

  const beforeDeletion = await input.control.registry.read();
  const currentReservation = beforeDeletion.retirementReservations.find(
    (entry) => entry.id === reservation.id,
  );
  const currentBuild = currentReservation
    ? candidateMatches(beforeDeletion, currentReservation)
    : undefined;
  if (!currentReservation || !currentBuild) return false;

  let deletion: string;
  try {
    deletion = await input.control.run(
      buildRemoteAgentRetirementDeletionCommand(validateRemoteAgentRuntime(currentBuild.runtime)),
    );
  } catch {
    return false;
  }
  if (deletion.trim() !== "deleted") return false;

  const afterReferences = await readExternalReferences(input.referencedBuildIds);
  if (!afterReferences || afterReferences.has(currentBuild.id)) return false;

  let confirmed = false;
  try {
    await input.control.registry.update((current) => {
      const currentReservation = current.retirementReservations.find(
        (entry) => entry.id === reservation.id,
      );
      const currentBuild = currentReservation
        ? candidateMatches(current, currentReservation)
        : undefined;
      if (!currentReservation || !currentBuild) return current;
      confirmed = true;
      return confirmRemoteAgentRetirementDeletion(current, currentReservation.id);
    });
  } catch {
    return false;
  }
  return confirmed;
}

/** Reconcile a bounded set of persisted deletion tombstones after lost acknowledgements. */
export async function reconcileRemoteAgentRetirementTombstones(
  control: RemoteAgentControl,
  referencedBuildIds?: () => Promise<ReadonlySet<string>>,
): Promise<number> {
  let snapshot: RemoteAgentRegistry;
  try {
    snapshot = await control.registry.read();
  } catch {
    return 0;
  }
  const reservations = snapshot.retirementReservations
    .filter((entry) => candidateMatches(snapshot, entry) !== undefined)
    .slice(0, MAX_RETIREMENT_RECONCILIATIONS);
  let deleted = 0;
  for (const reservation of reservations) {
    if (
      await reconcileRetirementTombstone({
        control,
        reservation,
        ...(referencedBuildIds ? { referencedBuildIds } : {}),
      })
    )
      deleted++;
  }
  return deleted;
}
