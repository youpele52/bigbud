import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import {
  remoteAgentInventoryCapacityMessage,
  type RemoteAgentInventoryCapacityIssue,
} from "./remoteAgentUpdate.inventory.ts";

export type RemoteAgentUpdateStatusPhase =
  | "idle"
  | "waiting-for-authentication"
  | "waiting-for-capacity"
  | "capacity-noncompliant"
  | "reserved"
  | "installing"
  | "checking-health"
  | "ready-for-reconnect"
  | "failed-using-stable"
  | "verification-unavailable"
  | "connected";

export interface RemoteAgentUpdateStatus {
  readonly executionTargetId: string;
  readonly root: string | null;
  readonly phase: RemoteAgentUpdateStatusPhase;
  readonly requestId: string | null;
  readonly reconnectRequestId: string | null;
  readonly reconnectOutcome: "pending" | "selected" | "fallback" | "rejected" | null;
  readonly currentVersion: string | null;
  readonly candidateVersion: string | null;
  readonly predecessorVersion: string | null;
  readonly outcome: string | null;
  /** A warning or failure explaining the status; never a successful outcome such as `ready`. */
  readonly reason: string | null;
  readonly currentTargetTriple: string | null;
  readonly currentBuildDigestShort: string | null;
  readonly candidateTargetTriple: string | null;
  readonly candidateBuildDigestShort: string | null;
}

/** Short artifact SHA-256: two builds of one version (musl and gnu) never share it. */
function shortDigest(sha256: string | undefined): string | null {
  return sha256 ? sha256.slice(0, 12) : null;
}

export function statusFromState(
  target: string,
  root: string | null,
  state: RemoteAgentRegistry,
  authenticationUnavailable = false,
  reconnectRequestId?: string,
  capacityIssue: RemoteAgentInventoryCapacityIssue | null = null,
): RemoteAgentUpdateStatus {
  const update = state.updates.at(-1);
  const current = state.builds.find((build) => build.id === state.current);
  const candidate = update ? state.builds.find((build) => build.id === update.buildId) : undefined;
  const predecessor = state.builds.find((build) => build.id === state.predecessor);
  const admission = reconnectRequestId
    ? state.admissions.find((entry) => entry.id === reconnectRequestId)
    : undefined;
  const retired = reconnectRequestId
    ? state.admissionRetirements?.find((entry) => entry.id === reconnectRequestId)
    : undefined;
  const phase: RemoteAgentUpdateStatusPhase =
    authenticationUnavailable && !update
      ? "waiting-for-authentication"
      : capacityIssue
        ? "capacity-noncompliant"
        : update?.phase === "waiting-for-capacity"
          ? "waiting-for-capacity"
          : update?.phase === "reserved"
            ? "reserved"
            : update?.phase === "installing"
              ? "installing"
              : update?.phase === "checking"
                ? "checking-health"
                : update?.phase === "ready-for-reconnect"
                  ? "ready-for-reconnect"
                  : update?.phase === "failed"
                    ? "failed-using-stable"
                    : update?.phase === "uncertain"
                      ? "verification-unavailable"
                      : current
                        ? "connected"
                        : "idle";
  return {
    executionTargetId: target,
    root,
    phase,
    requestId: update?.requestId ?? null,
    reconnectRequestId: reconnectRequestId ?? state.currentConnectionId ?? null,
    reconnectOutcome:
      admission?.phase === "prepared"
        ? "pending"
        : (admission?.outcome ?? retired?.outcome ?? null),
    currentVersion: current?.runtime.version ?? null,
    candidateVersion: candidate?.runtime.version ?? update?.identity?.version ?? null,
    predecessorVersion: predecessor?.runtime.version ?? null,
    outcome: update?.outcome ?? null,
    reason:
      (capacityIssue ? remoteAgentInventoryCapacityMessage(capacityIssue) : undefined) ??
      admission?.warning ??
      retired?.warning ??
      admission?.failureCode ??
      retired?.failureCode ??
      update?.reason ??
      null,
    currentTargetTriple: current?.runtime.targetTriple ?? null,
    currentBuildDigestShort: shortDigest(current?.runtime.sha256),
    candidateTargetTriple:
      candidate?.runtime.targetTriple ?? update?.identity?.targetTriple ?? null,
    candidateBuildDigestShort: shortDigest(candidate?.runtime.sha256 ?? update?.identity?.sha256),
  };
}
