import {
  REMOTE_AGENT_STAGE_LEASE_MS,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import { remoteAgentRuntimeEqual } from "./remoteAgentRuntime.ts";

export interface RemoteAgentStageController {
  readonly id: string;
  readonly pid: number;
  readonly startedAt: string;
}

function changed(
  state: RemoteAgentRegistry,
  patch: Partial<RemoteAgentRegistry>,
): RemoteAgentRegistry {
  return parseRemoteAgentRegistry(
    JSON.stringify({ ...state, ...patch, revision: state.revision + 1 }),
  );
}

/** Reserve before install/reuse/check, so concurrent cleanup cannot unlink a restaged build. */
export function reserveRemoteAgentStage(
  state: RemoteAgentRegistry,
  id: string,
  build: RemoteAgentRegistryBuild,
  controller?: RemoteAgentStageController,
): RemoteAgentRegistry {
  const reconciled = reconcileRemoteAgentStages(state);
  state = reconciled;
  const prior = state.stages.find((stage) => stage.id === id);
  if (prior) {
    if (prior.buildId !== build.id) throw new Error("Staging identity conflict.");
    return state;
  }
  const existing = state.builds.find((entry) => entry.id === build.id);
  if (existing?.binary === "deleting")
    throw new Error("Build deletion must reconcile before staging.");
  if (existing && !remoteAgentRuntimeEqual(existing.runtime, build.runtime)) {
    throw new Error("Immutable runtime descriptor conflict.");
  }
  return changed(state, {
    builds: existing ? state.builds : [...state.builds, build],
    stages: [
      ...state.stages,
      {
        id,
        buildId: build.id,
        phase: "reserved",
        ...(controller
          ? {
              controllerId: controller.id,
              controllerPid: controller.pid,
              controllerStartedAt: controller.startedAt,
            }
          : {}),
        reservedAt: Date.now(),
        // Kept for old registry readers; expiry is advisory and never releases ownership.
        leaseExpiresAt: Date.now() + REMOTE_AGENT_STAGE_LEASE_MS,
      },
    ],
  });
}

/** Record a staging failure without converting an ambiguous install into deletion evidence. */
export function failRemoteAgentStage(
  state: RemoteAgentRegistry,
  id: string,
  failure: "definitive" | "ambiguous",
): RemoteAgentRegistry {
  const stage = state.stages.find((entry) => entry.id === id);
  if (!stage || stage.phase === "published" || stage.phase === "cancelled") return state;
  const protectedBuild =
    state.current === stage.buildId ||
    state.pins.some((pin) => pin.buildId === stage.buildId) ||
    state.launches.some(
      (launch) => launch.buildId === stage.buildId && launch.phase !== "proven-dead",
    ) ||
    state.admissions.some((admission) => admission.buildId === stage.buildId);
  if (failure === "definitive") {
    return changed(state, {
      pending: state.pending === stage.buildId && !protectedBuild ? null : state.pending,
      stages: state.stages.filter((entry) => entry.id !== id),
      builds: state.builds.map((build) =>
        build.id === stage.buildId && !protectedBuild
          ? {
              // The installer may have durably linked bytes before the check
              // failed. Keep the build and its reservation until retirement
              // proves that exact bytes were removed.
              ...build,
              binary: "present" as const,
              health: "quarantined" as const,
            }
          : build,
      ),
    });
  }
  const now = Date.now();
  return changed(state, {
    stages: state.stages.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            phase: "failed" as const,
            failure: "ambiguous" as const,
            reservedAt: entry.reservedAt ?? now,
            // An ambiguous remote command remains fenced until its owner is reconciled.
            leaseExpiresAt: entry.leaseExpiresAt ?? now + REMOTE_AGENT_STAGE_LEASE_MS,
          }
        : entry,
    ),
  });
}

/** Clock-only reconciliation is intentionally non-destructive; fences prove release. */
export function reconcileRemoteAgentStages(
  state: RemoteAgentRegistry,
  _now = Date.now(),
): RemoteAgentRegistry {
  // A clock cannot prove that an SSH command and its remote child stopped. Keep
  // unresolved reservations until the remote fence and controller owner are
  // reconciled by the effectful cleanup path.
  return state;
}

/** Cancel only after the caller has proven its remote fence is no longer live. */
export function releaseRemoteAgentStage(
  state: RemoteAgentRegistry,
  id: string,
  controller?: RemoteAgentStageController,
): RemoteAgentRegistry {
  const stage = state.stages.find((entry) => entry.id === id);
  if (!stage || stage.phase === "published" || stage.phase === "cancelled") return state;
  if (
    stage.controllerId === undefined ||
    !controller ||
    stage.controllerId !== controller.id ||
    stage.controllerPid !== controller.pid ||
    stage.controllerStartedAt !== controller.startedAt
  )
    throw new Error("Staging controller ownership changed.");
  return changed(state, {
    stages: state.stages.map((entry) =>
      entry.id === id ? { ...entry, phase: "cancelled" as const, failure: undefined } : entry,
    ),
  });
}

export function publishRemoteAgentStage(
  state: RemoteAgentRegistry,
  id: string,
): RemoteAgentRegistry {
  const stage = state.stages.find((entry) => entry.id === id);
  if (!stage) throw new Error("Staging reservation is unavailable; reconcile before publication.");
  if (stage.phase === "published") return state;
  if (stage.phase === "cancelled") throw new Error("Staging was cancelled.");
  return changed(state, {
    pending: stage.buildId,
    builds: state.builds.map((build) =>
      build.id === stage.buildId ? { ...build, binary: "present" } : build,
    ),
    stages: state.stages.map((entry) =>
      entry.id === id ? { ...entry, phase: "published" } : entry,
    ),
    slotReservations: state.slotReservations.map((reservation) =>
      reservation.buildId === stage.buildId &&
      reservation.requestId === id &&
      reservation.phase === "reserved"
        ? { ...reservation, phase: "occupied" as const }
        : reservation,
    ),
    // Keep the intent as durable publication evidence until the caller reconciles its acknowledgement.
  });
}

export function pinRemoteAgentBuild(
  state: RemoteAgentRegistry,
  owner: string,
  buildId: string,
): RemoteAgentRegistry {
  const prior = state.pins.find((pin) => pin.owner === owner);
  if (prior) {
    if (prior.buildId !== buildId) throw new Error("An existing owner cannot migrate generations.");
    return state;
  }
  if (state.builds.find((build) => build.id === buildId)?.binary !== "present") {
    throw new Error("Cannot acquire an absent or deleting binary.");
  }
  return changed(state, { pins: [...state.pins, { owner, buildId }] });
}

export function releaseRemoteAgentPin(
  state: RemoteAgentRegistry,
  owner: string,
): RemoteAgentRegistry {
  if (!state.pins.some((pin) => pin.owner === owner)) return state;
  return changed(state, { pins: state.pins.filter((pin) => pin.owner !== owner) });
}

/** Promotion order belongs to distinct proven healthy builds, not pings or staging time. */
export function promoteRemoteAgentBuild(
  state: RemoteAgentRegistry,
  buildId: string,
  admission?: {
    readonly id: string;
    readonly epoch: string;
    readonly requestedBuildId?: string;
    readonly failureCode?: string;
  },
): RemoteAgentRegistry {
  const build = state.builds.find((entry) => entry.id === buildId);
  if (!build || !build.authenticated || build.binary !== "present")
    throw new Error("Build is not admissible.");
  if (
    !state.launches.some(
      (launch) => launch.buildId === buildId && launch.phase === "ready" && launch.epoch,
    )
  ) {
    throw new Error("Build has no verified ready runtime.");
  }
  const promotion = build.promotion || state.promotionSequence + 1;
  const predecessor =
    state.current && state.current !== buildId ? state.current : state.predecessor;
  return changed(state, {
    current: buildId,
    predecessor: predecessor ?? null,
    ...(admission
      ? {
          currentConnectionId: admission.id,
          admissions: state.admissions.map((entry) =>
            entry.id === admission.id
              ? {
                  ...entry,
                  buildId,
                  phase: "ready" as const,
                  epoch: admission.epoch,
                  outcome:
                    admission.requestedBuildId && admission.requestedBuildId !== buildId
                      ? ("fallback" as const)
                      : ("selected" as const),
                  ...(admission.requestedBuildId
                    ? { requestedBuildId: admission.requestedBuildId }
                    : {}),
                  ...(admission.failureCode ? { failureCode: admission.failureCode } : {}),
                }
              : entry,
          ),
        }
      : {}),
    pending: state.pending === buildId ? null : state.pending,
    promotionSequence: Math.max(state.promotionSequence, promotion),
    builds: state.builds.map((entry) =>
      entry.id === buildId ? { ...entry, health: "healthy", promotion } : entry,
    ),
  });
}

/** Quarantine a build and release only an unadmitted pending selector. */
export function quarantineRemoteAgentBuild(
  state: RemoteAgentRegistry,
  buildId: string,
): RemoteAgentRegistry {
  const protectedBuild =
    state.current === buildId ||
    state.pins.some((pin) => pin.buildId === buildId) ||
    state.launches.some((launch) => launch.buildId === buildId && launch.phase !== "proven-dead") ||
    state.admissions.some((admission) => admission.buildId === buildId);
  return changed(state, {
    pending: state.pending === buildId && !protectedBuild ? null : state.pending,
    builds: state.builds.map((build) =>
      build.id === buildId ? { ...build, health: "quarantined" as const } : build,
    ),
  });
}

/** Uncertain/live launches and unknown legacy ownership are references, never TTL leases. */
export function retainedRemoteAgentBuilds(state: RemoteAgentRegistry): ReadonlySet<string> {
  const protectedBuilds = new Set([
    ...[state.current, state.predecessor, state.pending].filter(
      (buildId): buildId is string => buildId !== null,
    ),
    ...state.pins.map((pin) => pin.buildId),
    ...state.launches
      .filter((launch) => launch.phase !== "proven-dead")
      .map((launch) => launch.buildId),
    ...state.admissions.map((admission) => admission.buildId),
    ...state.updates.map((update) => update.buildId),
    // A released row is immutable slot/replay evidence. It remains a build
    // reference even though its physical slot is available for reuse.
    ...state.slotReservations.map((reservation) => reservation.buildId),
    ...state.retirementReservations
      .filter((retirement) => {
        if (retirement.phase !== "tombstoned") return true;
        // `tombstoned` is only compactable after the exact binary unlink has
        // been confirmed. Until then the row still fences reconciliation.
        return state.builds.find((build) => build.id === retirement.buildId)?.binary !== "absent";
      })
      .map((retirement) => retirement.buildId),
    ...(state.admissionRetirements ?? []).map((retirement) => retirement.buildId),
  ]);
  return new Set([
    ...state.builds
      .filter((build) => build.health === "healthy")
      .toSorted((a, b) => b.promotion - a.promotion)
      .slice(0, 2)
      .map((build) => build.id),
    ...protectedBuilds,
    ...state.stages
      .filter(
        (stage) =>
          stage.phase === "reserved" || (stage.phase === "failed" && stage.failure === "ambiguous"),
      )
      .map((stage) => stage.buildId),
    ...state.builds
      .filter((build) => build.runtime.origin === "legacy-external")
      .map((build) => build.id),
  ]);
}

export function tombstoneRemoteAgentBuild(
  state: RemoteAgentRegistry,
  buildId: string,
): RemoteAgentRegistry {
  if (retainedRemoteAgentBuilds(state).has(buildId)) throw new Error("Build is retained.");
  const build = state.builds.find((entry) => entry.id === buildId);
  if (!build || build.runtime.origin !== "managed") throw new Error("Build is not owned.");
  return changed(state, {
    builds: state.builds.map((entry) =>
      entry.id === buildId ? { ...entry, binary: "deleting" } : entry,
    ),
  });
}
