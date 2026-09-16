import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

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
  readonly reason: string | null;
}

export function statusFromState(
  target: string,
  root: string | null,
  state: RemoteAgentRegistry,
  authenticationUnavailable = false,
  reconnectRequestId?: string,
  capacityNoncompliant = false,
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
      : capacityNoncompliant
        ? "capacity-noncompliant"
        : update?.phase === "waiting-for-capacity"
          ? update.outcome === "capacity" && state.builds.length > 2
            ? "capacity-noncompliant"
            : "waiting-for-capacity"
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
    reason: admission?.failureCode ?? update?.outcome ?? null,
  };
}
