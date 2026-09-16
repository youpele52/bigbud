import type { ServerRemoteAgentRuntimeSummary } from "@bigbud/contracts/server/server.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

export function remoteAgentRuntimeSummary(
  state: RemoteAgentRegistry,
): ServerRemoteAgentRuntimeSummary {
  const current = state.builds.find((build) => build.id === state.current);
  const admission = state.admissions.find((entry) => entry.id === state.currentConnectionId);
  const pending = state.builds.find(
    (build) => build.id === state.pending && build.health !== "quarantined",
  );
  const fallback = state.builds
    .filter(
      (build) => build.id !== state.current && build.authenticated && build.health === "healthy",
    )
    .toSorted((a, b) => b.promotion - a.promotion)[0];
  return {
    ...(current ? { currentBuildId: current.id } : {}),
    ...(admission?.outcome ? { outcome: admission.outcome } : {}),
    ...(admission?.requestedBuildId ? { requestedBuildId: admission.requestedBuildId } : {}),
    ...(admission?.failureCode ? { failureCode: admission.failureCode } : {}),
    ...(state.currentConnectionId ? { connectionId: state.currentConnectionId } : {}),
    currentVersion: current?.runtime.version ?? null,
    pendingVersion: pending?.runtime.version ?? null,
    fallbackVersion: fallback?.runtime.version ?? null,
  };
}
