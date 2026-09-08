import type {
  RemoteAgentRegistry,
  RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentInventory } from "./remoteAgentUpdate.inventory.ts";
import { REMOTE_AGENT_SLOT_IDS, parseRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { remoteAgentRuntimeEqual } from "./remoteAgentRuntime.ts";

export const REMOTE_AGENT_SLOT_COUNT = 2;

export type RemoteAgentCapacityDecision =
  | { readonly status: "reserved"; readonly slotId: string; readonly state: RemoteAgentRegistry }
  | { readonly status: "joined"; readonly slotId: string; readonly state: RemoteAgentRegistry }
  | {
      readonly status: "waiting-for-capacity" | "capacity-noncompliant";
      readonly state: RemoteAgentRegistry;
      readonly physicalBuildCount: number;
    };

function changed(
  state: RemoteAgentRegistry,
  patch: Partial<RemoteAgentRegistry>,
): RemoteAgentRegistry {
  return parseRemoteAgentRegistry(
    JSON.stringify({ ...state, ...patch, revision: state.revision + 1 }),
  );
}

function updateRecord(
  state: RemoteAgentRegistry,
  requestId: string,
  buildId: string,
  phase: RemoteAgentRegistry["updates"][number]["phase"],
  outcome?: RemoteAgentRegistry["updates"][number]["outcome"],
): RemoteAgentRegistry["updates"][number] {
  const prior = state.updates.find((update) => update.requestId === requestId);
  return {
    requestId,
    buildId,
    phase,
    ...(outcome ? { outcome } : {}),
    ...(prior?.identity ? { identity: prior.identity } : {}),
    ...(prior?.epoch ? { epoch: prior.epoch } : {}),
    ...(prior?.predecessorBuildId ? { predecessorBuildId: prior.predecessorBuildId } : {}),
  };
}

function slotIdForReservation(
  reservation: RemoteAgentRegistry["slotReservations"][number],
): string {
  return reservation.slotId ?? reservation.id.split(":", 1)[0]!;
}

export function remoteAgentCapacitySnapshot(
  state: RemoteAgentRegistry,
  inventory: RemoteAgentInventory,
): {
  readonly physicalBuildCount: number;
  readonly occupiedDigests: ReadonlySet<string>;
  readonly uncertain: boolean;
  readonly unknownOwner: boolean;
  readonly noncompliant: boolean;
} {
  const occupiedDigests = new Set(inventory.uniqueDigests);
  let uncertain = inventory.uncertain;
  for (const build of state.builds) {
    if (build.binary !== "present") continue;
    if (!occupiedDigests.has(build.runtime.sha256)) uncertain = true;
  }
  for (const reservation of state.slotReservations) {
    if (reservation.phase === "released") continue;
    occupiedDigests.add(
      state.builds.find((build) => build.id === reservation.buildId)?.runtime.sha256 ??
        reservation.buildId,
    );
  }
  return {
    physicalBuildCount: occupiedDigests.size,
    occupiedDigests,
    uncertain,
    unknownOwner: inventory.unknownOwner,
    noncompliant:
      inventory.noncompliant || uncertain || inventory.uniqueDigests.size > REMOTE_AGENT_SLOT_COUNT,
  };
}

/** Reserve a slot before the remote installer can write even one candidate byte. */
export function reserveRemoteAgentUpdate(input: {
  readonly state: RemoteAgentRegistry;
  readonly requestId: string;
  readonly build: RemoteAgentRegistryBuild;
  readonly inventory: RemoteAgentInventory;
  readonly controllerId?: string;
}): RemoteAgentCapacityDecision {
  const { state, requestId, build, inventory } = input;
  const priorReservation = state.slotReservations.find(
    (reservation) =>
      reservation.requestId === requestId &&
      reservation.buildId === build.id &&
      reservation.phase !== "released",
  );
  const existingReservation = state.slotReservations.find(
    (reservation) => reservation.buildId === build.id && reservation.phase !== "released",
  );
  const snapshot = remoteAgentCapacitySnapshot(state, inventory);
  const existingBuild = state.builds.find((entry) => entry.id === build.id);
  const withBuild = existingBuild ? state : { ...state, builds: [...state.builds, build] };
  if (snapshot.noncompliant && !snapshot.occupiedDigests.has(build.runtime.sha256)) {
    return {
      status: "capacity-noncompliant",
      physicalBuildCount: snapshot.physicalBuildCount,
      state: changed(withBuild, {
        updates: [
          ...withBuild.updates.filter((update) => update.requestId !== requestId),
          updateRecord(withBuild, requestId, build.id, "waiting-for-capacity", "capacity"),
        ],
      }),
    };
  }
  if (
    priorReservation ||
    existingReservation ||
    snapshot.occupiedDigests.has(build.runtime.sha256)
  ) {
    const reservation = priorReservation ?? existingReservation;
    const slotId = reservation
      ? slotIdForReservation(reservation)
      : `occupied:${build.runtime.sha256}`;
    return {
      status: "joined",
      slotId,
      state: changed(withBuild, {
        updates: [
          ...withBuild.updates.filter((update) => update.requestId !== requestId),
          updateRecord(withBuild, requestId, build.id, "reserved"),
        ],
      }),
    };
  }
  if (snapshot.occupiedDigests.size >= REMOTE_AGENT_SLOT_COUNT) {
    return {
      status: "waiting-for-capacity",
      physicalBuildCount: snapshot.physicalBuildCount,
      state: changed(withBuild, {
        updates: [
          ...withBuild.updates.filter((update) => update.requestId !== requestId),
          updateRecord(withBuild, requestId, build.id, "waiting-for-capacity", "capacity"),
        ],
      }),
    };
  }
  const slotIndex = [0, 1].find(
    (index) =>
      !withBuild.slotReservations.some(
        (reservation) =>
          slotIdForReservation(reservation) === REMOTE_AGENT_SLOT_IDS[index] &&
          reservation.phase !== "released",
      ),
  );
  if (slotIndex === undefined) throw new Error("Remote agent slot accounting is exhausted.");
  const slotId = REMOTE_AGENT_SLOT_IDS[slotIndex]!;
  const reservationId = `${slotId}:${requestId}:${state.revision + 1}`;
  const next = changed(withBuild, {
    slotReservations: [
      ...withBuild.slotReservations,
      {
        id: reservationId,
        slotId,
        requestId,
        buildId: build.id,
        phase: "reserved" as const,
        ...(input.controllerId ? { controllerId: input.controllerId } : {}),
      },
    ],
    updates: [
      ...withBuild.updates.filter((update) => update.requestId !== requestId),
      updateRecord(withBuild, requestId, build.id, "reserved"),
    ],
  });
  return { status: "reserved", slotId, state: next };
}

export function markRemoteAgentUpdate(
  state: RemoteAgentRegistry,
  input: {
    readonly requestId: string;
    readonly buildId: string;
    readonly phase: RemoteAgentRegistry["updates"][number]["phase"];
    readonly outcome?: RemoteAgentRegistry["updates"][number]["outcome"];
    readonly identity?: RemoteAgentRegistry["updates"][number]["identity"];
    readonly epoch?: string;
  },
): RemoteAgentRegistry {
  const prior = state.updates.find((update) => update.requestId === input.requestId);
  const update = {
    ...updateRecord(state, input.requestId, input.buildId, input.phase, input.outcome),
    ...((input.identity ?? prior?.identity) ? { identity: input.identity ?? prior?.identity } : {}),
    ...((input.epoch ?? prior?.epoch) ? { epoch: input.epoch ?? prior?.epoch } : {}),
  };
  return changed(state, {
    updates: [...state.updates.filter((entry) => entry.requestId !== input.requestId), update],
  });
}

export function withdrawRemoteAgentPredecessor(
  state: RemoteAgentRegistry,
  requestId: string,
  buildId: string,
): RemoteAgentRegistry {
  if (state.predecessor !== buildId || state.current === buildId)
    throw new Error("Only the obsolete stable predecessor may be withdrawn.");
  if (
    !state.retirementReservations.some(
      (entry) => entry.buildId === buildId && entry.phase !== "failed",
    )
  )
    throw new Error("Predecessor withdrawal requires a safe retirement reservation.");
  const next = { ...state, predecessor: null };
  const update = updateRecord(next, requestId, buildId, "reserved", "capacity");
  return changed(state, {
    predecessor: null,
    updates: [...state.updates.filter((entry) => entry.requestId !== requestId), update],
  });
}

export function releaseRemoteAgentSlot(
  state: RemoteAgentRegistry,
  buildId: string,
): RemoteAgentRegistry {
  const reservations = state.slotReservations.map((reservation) =>
    reservation.buildId === buildId ? { ...reservation, phase: "released" as const } : reservation,
  );
  return changed(state, { slotReservations: reservations });
}

export function setRemoteAgentUpdateIdentity(
  state: RemoteAgentRegistry,
  requestId: string,
  identity: RemoteAgentRegistry["updates"][number]["identity"],
  epoch?: string,
): RemoteAgentRegistry {
  const update = state.updates.find((entry) => entry.requestId === requestId);
  if (!update) throw new Error("Remote agent update request is missing.");
  return markRemoteAgentUpdate(state, {
    requestId,
    buildId: update.buildId,
    phase: update.phase,
    ...(update.outcome ? { outcome: update.outcome } : {}),
    ...(identity ? { identity } : {}),
    ...(epoch ? { epoch } : {}),
  });
}

export function sameRemoteAgentBuild(
  left: RemoteAgentRegistryBuild,
  right: RemoteAgentRegistryBuild,
): boolean {
  return left.id === right.id && remoteAgentRuntimeEqual(left.runtime, right.runtime);
}
