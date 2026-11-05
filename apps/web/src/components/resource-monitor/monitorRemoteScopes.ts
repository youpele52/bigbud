import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { MonitorScope } from "./MonitorScopeToggle";

export interface RemoteMonitorScope {
  scope: `vps:${string}`;
  name: string;
  target: string;
}
export interface ConnectedSshMonitorProject {
  projectId: ProjectId;
  name: string;
  target: string;
}

export function availableMonitorScope(
  scope: MonitorScope,
  remotes: readonly RemoteMonitorScope[],
): MonitorScope {
  return scope.startsWith("vps:") && !remotes.some((entry) => entry.scope === scope)
    ? "system"
    : scope;
}

/** Display only server-authorized saved workspaces, independent of partial client catalog pages. */
export function connectedRemoteMonitorScopes(
  projects: readonly ConnectedSshMonitorProject[],
): RemoteMonitorScope[] {
  const connected = projects.map(({ projectId, name, target }) => ({
    scope: `vps:${projectId}` as const,
    name,
    target,
  }));
  const counts = new Map<string, number>();
  for (const entry of connected) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  return connected.map((entry) => ({
    scope: entry.scope,
    target: entry.target,
    name:
      (counts.get(entry.name) ?? 0) > 1 ? `${entry.name} (${entry.scope.slice(4)})` : entry.name,
  }));
}
