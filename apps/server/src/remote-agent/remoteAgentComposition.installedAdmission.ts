import type { InstalledProxySelection } from "./remoteAgentComposition.installedProxy.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import {
  remoteAgentBuildId,
  remoteAgentRuntimeEqual,
  validateRemoteAgentRuntime,
  type RemoteAgentRuntime,
} from "./remoteAgentRuntime.ts";

/** Supplied by a trusted, endpoint-scoped detector, not by registry or project metadata. */
export interface VerifiedInstalledProxyObservation {
  readonly executionTargetId: string;
  readonly runtime: RemoteAgentRuntime;
  readonly supervisorEpoch: string;
  readonly agentInstanceId: string;
}

type InstalledProxyDetection =
  | { readonly kind: "ready"; readonly binding: InstalledProxySelection["binding"] }
  | {
      readonly kind: "denied";
      readonly reason:
        | "not-admitted"
        | "lifecycle-unsettled"
        | "observation-required"
        | "identity-mismatch";
    };

/**
 * Project a read-only registry snapshot and an independently verified observation into
 * an exact composition binding. This neither discovers nor starts a supervisor. The
 * eventual owner still has to recheck approval at acquisition, and the pool checks hello.
 */
export function detectInstalledProxyBinding(
  executionTargetId: string,
  state: RemoteAgentRegistry | null,
  observed?: VerifiedInstalledProxyObservation,
): InstalledProxyDetection {
  const build = state?.builds.find((entry) => entry.id === state.current);
  const admission = state?.admissions.find((entry) => entry.id === state.currentConnectionId);
  if (
    !state ||
    !build ||
    build.runtime.origin !== "managed" ||
    !build.authenticated ||
    build.binary !== "present" ||
    build.health !== "healthy" ||
    !admission ||
    admission.phase !== "ready" ||
    admission.buildId !== build.id ||
    !state.pins.some(
      (pin) => pin.owner === `connection:${admission.id}` && pin.buildId === build.id,
    )
  ) {
    return { kind: "denied", reason: "not-admitted" };
  }
  const launches = state.launches.filter(
    (launch) => launch.buildId === build.id && launch.phase !== "proven-dead",
  );
  const [launch] = launches;
  if (
    state.removal ||
    launches.length !== 1 ||
    launch?.phase !== "ready" ||
    launch.id !== build.runtime.generation ||
    !admission.epoch ||
    launch.epoch !== admission.epoch ||
    state.retirementReservations.some(
      (entry) => entry.buildId === build.id && entry.phase !== "failed",
    ) ||
    state.restartReservations.some(
      (entry) => entry.buildId === build.id && entry.phase !== "ready" && entry.phase !== "failed",
    )
  ) {
    return { kind: "denied", reason: "lifecycle-unsettled" };
  }
  if (!observed?.agentInstanceId) return { kind: "denied", reason: "observation-required" };
  try {
    const runtime = validateRemoteAgentRuntime(build.runtime);
    if (
      executionTargetId &&
      observed.executionTargetId === executionTargetId &&
      observed.supervisorEpoch === launch.epoch &&
      remoteAgentBuildId(runtime) === build.id &&
      remoteAgentRuntimeEqual(runtime, validateRemoteAgentRuntime(observed.runtime))
    ) {
      return {
        kind: "ready",
        binding: Object.freeze({
          connectionId: admission.id,
          runtime,
          expectedEpoch: launch.epoch,
          expectedInstanceId: observed.agentInstanceId,
        }),
      };
    }
  } catch {
    // Unusable descriptors cannot become a composition binding.
  }
  return { kind: "denied", reason: "identity-mismatch" };
}
