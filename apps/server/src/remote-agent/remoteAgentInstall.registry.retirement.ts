import type {
  RemoteAgentRegistry,
  RemoteAgentRetirementReservation,
} from "./remoteAgentInstall.registry.ts";
import { parseRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

function changed(
  state: RemoteAgentRegistry,
  patch: Partial<RemoteAgentRegistry>,
): RemoteAgentRegistry {
  return parseRemoteAgentRegistry(
    JSON.stringify({ ...state, ...patch, revision: state.revision + 1 }),
  );
}

function reservation(
  state: RemoteAgentRegistry,
  id: string,
): RemoteAgentRetirementReservation | undefined {
  return state.retirementReservations.find((entry) => entry.id === id);
}

/** Keep a rejected retirement attempt as inactive evidence, never as a fence. */
export function recordRemoteAgentRetirementFailure(
  state: RemoteAgentRegistry,
  input: {
    readonly id: string;
    readonly buildId: string;
    readonly failure: string;
    readonly controllerId?: string;
  },
): RemoteAgentRegistry {
  const build = state.builds.find((entry) => entry.id === input.buildId);
  if (!build || build.runtime.origin !== "managed" || state.current === input.buildId) return state;
  const prior = reservation(state, input.id);
  if (prior) {
    if (prior.buildId !== input.buildId || prior.generation !== build.runtime.generation)
      throw new Error("Retirement reservation identity changed.");
    if (prior.controllerId !== input.controllerId) return state;
    return prior.phase === "failed"
      ? state
      : advanceRemoteAgentRetirement(state, input.id, "failed", input.failure);
  }
  if (
    state.retirementReservations.some(
      (entry) => entry.buildId === input.buildId && entry.phase !== "failed",
    )
  )
    return state;
  return changed(state, {
    retirementReservations: [
      ...state.retirementReservations,
      {
        id: input.id,
        buildId: input.buildId,
        generation: build.runtime.generation,
        phase: "failed" as const,
        failure: input.failure,
        ...(input.controllerId ? { controllerId: input.controllerId } : {}),
      },
    ],
  });
}

/** Reserve only an obsolete managed generation; this is not a PID lease. */
export function reserveRemoteAgentRetirement(
  state: RemoteAgentRegistry,
  input: {
    readonly id: string;
    readonly buildId: string;
    readonly expectedEpoch?: string;
    readonly controllerId?: string;
    /** Atomically withdraw the obsolete predecessor with its retirement reservation. */
    readonly withdrawPredecessor?: boolean;
    /** Reserve a predecessor while liveness is fenced; withdraw only after it is safe. */
    readonly allowPredecessorReservation?: boolean;
  },
): RemoteAgentRegistry {
  const build = state.builds.find((entry) => entry.id === input.buildId);
  if (!build || build.runtime.origin !== "managed")
    throw new Error("Only a managed runtime may be retired automatically.");
  if (state.current === input.buildId)
    throw new Error("The current stable runtime is protected from retirement.");
  if (
    state.predecessor === input.buildId &&
    !input.withdrawPredecessor &&
    !input.allowPredecessorReservation
  )
    throw new Error("The predecessor must be withdrawn by a replacement reservation first.");
  const prior = reservation(state, input.id);
  if (prior) {
    if (prior.buildId !== input.buildId || prior.generation !== build.runtime.generation)
      throw new Error("Retirement reservation identity changed.");
    // A failed attempt retains its evidence but may be retried by a later
    // controller. Active reservations remain owned until reconciliation.
    if (prior.phase !== "failed") {
      if (prior.controllerId && input.controllerId && prior.controllerId !== input.controllerId)
        throw new Error("Retirement reservation belongs to another controller.");
    } else if (input.controllerId && prior.controllerId !== input.controllerId) {
      return changed(state, {
        retirementReservations: state.retirementReservations.map((entry) =>
          entry.id === input.id ? { ...entry, controllerId: input.controllerId } : entry,
        ),
      });
    }
    return state;
  }
  if (
    state.retirementReservations.some(
      (entry) => entry.buildId === input.buildId && entry.phase !== "failed",
    )
  )
    throw new Error("Managed runtime retirement is already reserved.");
  if (
    state.pins.some((pin) => pin.buildId === input.buildId) ||
    state.stages.some((stage) => stage.buildId === input.buildId && stage.phase !== "cancelled") ||
    state.launches.some(
      (launch) => launch.buildId === input.buildId && launch.phase !== "proven-dead",
    ) ||
    state.admissions.some((admission) => admission.buildId === input.buildId)
  )
    throw new Error("Managed runtime still has durable references.");
  return changed(state, {
    predecessor: input.withdrawPredecessor ? null : state.predecessor,
    retirementReservations: [
      ...state.retirementReservations,
      {
        id: input.id,
        buildId: input.buildId,
        generation: build.runtime.generation,
        phase: "reserved" as const,
        ...(input.expectedEpoch ? { expectedEpoch: input.expectedEpoch } : {}),
        ...(input.controllerId ? { controllerId: input.controllerId } : {}),
      },
    ],
  });
}

export function advanceRemoteAgentRetirement(
  state: RemoteAgentRegistry,
  id: string,
  phase: RemoteAgentRetirementReservation["phase"],
  failure?: string,
): RemoteAgentRegistry {
  const prior = reservation(state, id);
  if (!prior) throw new Error("Retirement reservation is missing.");
  if (prior.phase === "tombstoned" && phase !== "tombstoned")
    throw new Error("A completed retirement cannot be reopened.");
  return changed(state, {
    retirementReservations: state.retirementReservations.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            phase,
            ...(failure ? { failure } : {}),
          }
        : entry,
    ),
  });
}

export function failRemoteAgentRetirement(
  state: RemoteAgentRegistry,
  id: string,
  failure: string,
): RemoteAgentRegistry {
  return advanceRemoteAgentRetirement(state, id, "failed", failure);
}

export function tombstoneRemoteAgentRetirement(
  state: RemoteAgentRegistry,
  id: string,
): RemoteAgentRegistry {
  const prior = reservation(state, id);
  if (!prior || prior.phase !== "exited") throw new Error("Managed runtime exit is not verified.");
  const build = state.builds.find((entry) => entry.id === prior.buildId);
  if (!build || build.binary !== "present") throw new Error("Retirement binary is unavailable.");
  return changed(state, {
    builds: state.builds.map((entry) =>
      entry.id === prior.buildId ? { ...entry, binary: "deleting" as const } : entry,
    ),
    retirementReservations: state.retirementReservations.map((entry) =>
      entry.id === id ? { ...entry, phase: "tombstoned" as const } : entry,
    ),
  });
}

export function confirmRemoteAgentRetirementDeletion(
  state: RemoteAgentRegistry,
  id: string,
): RemoteAgentRegistry {
  const prior = reservation(state, id);
  if (!prior || prior.phase !== "tombstoned")
    throw new Error("Retirement deletion tombstone is missing.");
  return changed(state, {
    builds: state.builds.map((entry) =>
      entry.id === prior.buildId ? { ...entry, binary: "absent" as const } : entry,
    ),
    slotReservations: state.slotReservations.map((entry) =>
      entry.buildId === prior.buildId ? { ...entry, phase: "released" as const } : entry,
    ),
  });
}
