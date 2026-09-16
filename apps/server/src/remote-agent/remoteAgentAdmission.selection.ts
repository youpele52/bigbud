import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentAdmissionPreparation } from "./remoteAgentUpdate.admission.types.ts";

export type ReadyRemoteAgentSelection = {
  readonly buildId: string;
  readonly epoch: string;
};

export function readyRemoteAgentSelection(
  state: RemoteAgentRegistry,
  buildId: string | null,
): ReadyRemoteAgentSelection | undefined {
  if (!buildId) return undefined;
  const build = state.builds.find((entry) => entry.id === buildId);
  const launch = state.launches.find(
    (entry) => entry.buildId === buildId && entry.phase === "ready" && entry.epoch,
  );
  if (
    !build ||
    !launch ||
    !build.authenticated ||
    build.binary !== "present" ||
    build.health === "quarantined"
  )
    return undefined;
  if (buildId === state.pending) {
    const update = state.updates.find(
      (entry) => entry.buildId === buildId && entry.phase === "ready-for-reconnect",
    );
    if (!update || update.epoch !== launch.epoch) return undefined;
  } else if (!build.authenticated || build.health !== "healthy") {
    return undefined;
  }
  return { buildId, epoch: launch.epoch };
}

export function readyRemoteAgentStableSelection(
  state: RemoteAgentRegistry,
  buildId: string | null,
): ReadyRemoteAgentSelection | undefined {
  const build = state.builds.find((entry) => entry.id === buildId);
  return build?.health === "healthy" ? readyRemoteAgentSelection(state, buildId) : undefined;
}

/** An update failure may select only an authenticated stable runtime. */
export function firstRemoteAgentSelection(
  state: RemoteAgentRegistry,
  preparation: RemoteAgentAdmissionPreparation = {},
): { readonly primary: string | null; readonly requestedBuildId?: string } {
  const requestedBuildId = preparation.requestedBuildId;
  const pending = preparation.warning
    ? undefined
    : readyRemoteAgentSelection(state, requestedBuildId ?? state.pending);
  if (pending && pending.buildId !== state.current)
    return { primary: pending.buildId, requestedBuildId: requestedBuildId ?? pending.buildId };
  const stable = [state.current, state.predecessor].find((id) =>
    readyRemoteAgentStableSelection(state, id),
  );
  return { primary: stable ?? null, ...(requestedBuildId ? { requestedBuildId } : {}) };
}
