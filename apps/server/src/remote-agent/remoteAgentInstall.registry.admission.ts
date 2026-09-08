import {
  MAX_REMOTE_AGENT_ADMISSION_RETIREMENTS,
  MAX_REMOTE_AGENT_BUILDS,
  MAX_REMOTE_AGENT_LAUNCHES,
  MAX_REMOTE_AGENT_STAGES,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import {
  reconcileRemoteAgentStages,
  retainedRemoteAgentBuilds,
} from "./remoteAgentInstall.registry.transitions.ts";

function changed(
  state: RemoteAgentRegistry,
  patch: Partial<RemoteAgentRegistry>,
): RemoteAgentRegistry {
  return parseRemoteAgentRegistry(
    JSON.stringify({ ...state, ...patch, revision: state.revision + 1 }),
  );
}

function keepTail<T>(entries: readonly T[], keep: (entry: T) => boolean, limit: number): T[] {
  const kept = entries.filter(keep);
  return kept.length <= limit ? kept : kept.slice(-limit);
}

function retiredAdmission(
  state: RemoteAgentRegistry,
  entry: Pick<
    RemoteAgentRegistry["admissions"][number],
    "id" | "buildId" | "epoch" | "requestedBuildId" | "failureCode"
  >,
  outcome: "selected" | "fallback" | "rejected",
  failureCode?: string,
): RemoteAgentRegistry {
  const existing = state.admissionRetirements?.find((retired) => retired.id === entry.id);
  if (existing) return state;
  const retirements = state.admissionRetirements ?? [];
  if (retirements.length >= MAX_REMOTE_AGENT_ADMISSION_RETIREMENTS)
    throw new Error("Admission retirement evidence is full; request admission is fenced.");
  return changed(state, {
    admissionRetirements: [
      ...retirements,
      {
        id: entry.id,
        buildId: entry.buildId,
        epoch: entry.epoch,
        outcome,
        ...(entry.requestedBuildId ? { requestedBuildId: entry.requestedBuildId } : {}),
        ...(failureCode
          ? { failureCode }
          : entry.failureCode
            ? { failureCode: entry.failureCode }
            : {}),
      },
    ],
  });
}

export function retireRemoteAgentAdmission(
  state: RemoteAgentRegistry,
  id: string,
  failureCode?: string,
): RemoteAgentRegistry {
  const entry = state.admissions.find((admission) => admission.id === id);
  if (!entry) return state;
  if (entry.phase !== "ready") throw new Error("Unresolved admission cannot be retired.");
  return retiredAdmission(state, entry, entry.outcome ?? "selected", failureCode);
}

/** Release only attempt pins proven not to have reached a runtime; uncertain launches stay pinned. */
export function rollbackRemoteAgentAdmission(
  state: RemoteAgentRegistry,
  requestId: string,
  buildId: string,
): RemoteAgentRegistry {
  const admission = state.admissions.find((entry) => entry.id === requestId);
  if (!admission || admission.buildId !== buildId) return state;
  const uncertain = state.launches.some(
    (launch) => launch.buildId === buildId && launch.phase !== "proven-dead",
  );
  if (uncertain) return state;
  return changed(state, {
    pins: state.pins.filter(
      (pin) =>
        pin.owner !== `connection:${requestId}` &&
        !pin.owner.startsWith(`activation:${requestId}:`),
    ),
  });
}

/** Retire a terminally rejected request only after every bounded candidate was tried. */
export function rejectRemoteAgentAdmission(
  state: RemoteAgentRegistry,
  requestId: string,
  failureCode?: string,
): RemoteAgentRegistry {
  const admission = state.admissions.find((entry) => entry.id === requestId);
  if (!admission || admission.phase !== "prepared") return state;
  const uncertain = state.launches.some(
    (launch) => launch.buildId === admission.buildId && launch.phase !== "proven-dead",
  );
  if (uncertain) return state;
  const fenced = retiredAdmission(state, admission, "rejected", failureCode);
  return changed(fenced, {
    admissions: state.admissions.filter((entry) => entry.id !== requestId),
    pins: state.pins.filter(
      (pin) =>
        pin.owner !== `connection:${requestId}` &&
        !pin.owner.startsWith(`activation:${requestId}:`),
    ),
  });
}

/** Bound history without removing unresolved admissions, launches, or pins. */
export function pruneRemoteAgentHistory(state: RemoteAgentRegistry): RemoteAgentRegistry {
  state = reconcileRemoteAgentStages(state);
  const unresolvedBuilds = new Set(
    state.launches
      .filter((launch) => launch.phase !== "proven-dead")
      .map((launch) => launch.buildId),
  );
  const activeAdmissionIds = new Set(
    state.pins
      .filter((pin) => pin.owner.startsWith("connection:"))
      .map((pin) => pin.owner.slice("connection:".length)),
  );
  const retainedAdmissions = state.admissions.filter(
    (entry) =>
      entry.phase === "prepared" ||
      entry.id === state.currentConnectionId ||
      activeAdmissionIds.has(entry.id),
  );
  const removableAdmissions = state.admissions.filter(
    (entry) => !retainedAdmissions.some((retainedEntry) => retainedEntry.id === entry.id),
  );
  const retirementSlots = Math.max(
    0,
    MAX_REMOTE_AGENT_ADMISSION_RETIREMENTS - (state.admissionRetirements?.length ?? 0),
  );
  const admissionsToRetire = removableAdmissions.slice(0, retirementSlots);
  const admissionRetirements = [
    ...(state.admissionRetirements ?? []),
    ...admissionsToRetire.map((entry) => ({
      id: entry.id,
      buildId: entry.buildId,
      epoch: entry.epoch,
      outcome: entry.outcome ?? ("selected" as const),
      ...(entry.requestedBuildId ? { requestedBuildId: entry.requestedBuildId } : {}),
      ...(entry.failureCode ? { failureCode: entry.failureCode } : {}),
    })),
  ];
  const compactedRetirementIds = new Set(
    state.retirementReservations
      .filter(
        (retirement) =>
          retirement.phase === "tombstoned" &&
          state.builds.find((build) => build.id === retirement.buildId)?.binary === "absent",
      )
      .map((retirement) => retirement.id),
  );
  // Include evidence created by this same prune pass before selecting the
  // bounded build history. Otherwise retiring an admission could remove its
  // build in the same CAS that records the replay fence.
  const retained = retainedRemoteAgentBuilds({
    ...state,
    admissionRetirements,
  });
  const builds = state.builds.filter(
    (entry) =>
      entry.id === state.current || retained.has(entry.id) || unresolvedBuilds.has(entry.id),
  );
  // A corrupt or concurrently assembled over-budget state must not lose a
  // protected build just to fit the normal tail. Leave it untouched so the
  // caller can reconcile the budget without discarding durable evidence.
  if (builds.length > MAX_REMOTE_AGENT_BUILDS) return state;
  return changed(state, {
    builds,
    pins: state.pins.filter(
      (pin) =>
        !(
          (pin.owner.startsWith("activation:") || pin.owner.startsWith("connection:")) &&
          state.launches.some((launch) => launch.buildId === pin.buildId) &&
          !unresolvedBuilds.has(pin.buildId) &&
          pin.owner !== `connection:${state.currentConnectionId}`
        ),
    ),
    admissions: [...retainedAdmissions, ...removableAdmissions.slice(admissionsToRetire.length)],
    admissionRetirements,
    retirementReservations: state.retirementReservations.filter(
      (retirement) => !compactedRetirementIds.has(retirement.id),
    ),
    stages: keepTail(
      state.stages,
      (entry) =>
        entry.phase === "reserved" ||
        (entry.phase === "failed" && entry.failure === "ambiguous") ||
        retained.has(entry.buildId),
      MAX_REMOTE_AGENT_STAGES,
    ),
    launches: keepTail(
      state.launches,
      (entry) => entry.phase !== "proven-dead" || retained.has(entry.buildId),
      MAX_REMOTE_AGENT_LAUNCHES,
    ),
  });
}
