import type { ServerRemoteAgentRuntimeSummary } from "@bigbud/contracts/server/server.ts";

import type { AppCheckStatus } from "../../lib/checkStatus";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import type { Project } from "../../models/types";
import { parseRemoteExecutionTarget } from "../sidebar/Sidebar.remoteWorkspaces.logic";

/** Connection evidence the Settings card reads from the remote access store; never opens SSH. */
export interface RemoteAgentHostConnectionState {
  readonly disconnectedExecutionTargetIds: Readonly<Record<string, true>>;
  readonly verifiedExecutionTargetIds: Readonly<Record<string, true>>;
  readonly executionTargetChecks: Readonly<Record<string, { readonly status: AppCheckStatus }>>;
  readonly remoteConnections: Readonly<Record<string, ServerRemoteAgentRuntimeSummary>>;
}

export interface RemoteAgentHost {
  /** Saved workspace execution target (agent or Direct SSH). */
  readonly target: string;
  readonly hostName: string;
  readonly hostLabel: string;
  readonly transport: "agent" | "direct-ssh";
  readonly projects: ReadonlyArray<Project>;
  readonly connected: boolean;
  /** SSH verified in this app session; saved verification is not persisted across restarts. */
  readonly hasConnectedOverSsh: boolean;
  readonly agentVersion: string | null;
}

function hostLabel(target: string): string {
  const parsed = parseRemoteExecutionTarget(target);
  if (!parsed) return target;
  const destination = parsed.username ? `${parsed.username}@${parsed.host}` : parsed.host;
  return parsed.port ? `${destination}:${parsed.port}` : destination;
}

/**
 * Every saved remote host (agent and Direct SSH), deduplicated by workspace target. Connected
 * hosts come first, then by host name; disconnected hosts sort last.
 */
export function buildRemoteAgentHosts(
  projects: ReadonlyArray<Project>,
  state: RemoteAgentHostConnectionState,
): RemoteAgentHost[] {
  const byTarget = new Map<string, Project[]>();
  for (const project of projects) {
    if (project.deletingAt) continue;
    const target = resolveWorkspaceExecutionTargetId(project);
    if (!target || !parseRemoteExecutionTarget(target)) continue;
    const existing = byTarget.get(target);
    if (existing) existing.push(project);
    else byTarget.set(target, [project]);
  }
  const hosts = [...byTarget].map(([target, hostProjects]): RemoteAgentHost => {
    const parsed = parseRemoteExecutionTarget(target)!;
    const verified =
      state.verifiedExecutionTargetIds[target] === true ||
      state.executionTargetChecks[target]?.status === "verified";
    const connected =
      state.disconnectedExecutionTargetIds[target] !== true &&
      (state.verifiedExecutionTargetIds[target] === true || target in state.remoteConnections);
    return {
      target,
      hostName: parsed.host,
      hostLabel: hostLabel(target),
      transport: parsed.remoteTransport,
      projects: hostProjects,
      connected,
      hasConnectedOverSsh: verified,
      agentVersion: state.remoteConnections[target]?.currentVersion ?? null,
    };
  });
  return hosts.toSorted(
    (left, right) =>
      Number(right.connected) - Number(left.connected) ||
      left.hostName.localeCompare(right.hostName) ||
      left.hostLabel.localeCompare(right.hostLabel) ||
      left.target.localeCompare(right.target),
  );
}

export type RemoteAgentHostStatus =
  | { readonly kind: "version"; readonly version: string }
  | { readonly kind: "not-installed" }
  | { readonly kind: "not-checked" };

/** Read-only status: the connected agent version, a removal this session, or unknown. */
export function remoteAgentHostStatus(
  host: RemoteAgentHost,
  removedThisSession: boolean,
): RemoteAgentHostStatus {
  if (removedThisSession) return { kind: "not-installed" };
  if (host.agentVersion) return { kind: "version", version: host.agentVersion };
  return { kind: "not-checked" };
}

export function remoteAgentHostStatusLabel(status: RemoteAgentHostStatus): string {
  switch (status.kind) {
    case "version":
      return `Agent ${status.version}`;
    case "not-installed":
      return "Not installed";
    case "not-checked":
      return "Not checked";
  }
}
