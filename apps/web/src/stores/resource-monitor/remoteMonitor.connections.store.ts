import { create } from "zustand";
import { getWsRpcClient } from "~/rpc/wsRpcClient";
import { isWsTransportDisconnectedError } from "~/rpc/wsTransport.errors";
import type { ConnectedSshMonitorProject } from "~/components/resource-monitor/monitorRemoteScopes";
import { useRemoteAccessStore } from "~/stores/remoteAccess/remoteAccess.store";
import { useStore } from "~/stores/main/main.store";
import { useRemoteMonitorStore } from "./remoteMonitor.store";

type DiscoveryStatus = "pending" | "ready" | "disconnected" | "unavailable";
export const useConnectedSshMonitorStore = create<{
  targets: Record<string, true>;
  projects: readonly ConnectedSshMonitorProject[];
  status: DiscoveryStatus;
}>(() => ({
  targets: {},
  projects: [],
  status: "pending",
}));
let owners = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
// An inconclusive failure hides options, but must not erase what a later authoritative
// response needs to revoke from renderer-side verification (including unloaded projects).
const previouslyAuthorizedTargets = new Set<string>();

async function refresh(token: number): Promise<void> {
  try {
    const projects = await getWsRpcClient().server.listConnectedSshMonitors();
    if (token !== generation) return;
    const next = Object.fromEntries(projects.map(({ target }) => [target, true as const]));
    useConnectedSshMonitorStore.setState({ targets: next, projects, status: "ready" });
    // Only an authoritative server response can revoke a cached renderer verification.
    const saved = new Set([
      ...previouslyAuthorizedTargets,
      ...useStore
        .getState()
        .projects.map((project) => project.workspaceExecutionTargetId ?? project.executionTargetId),
    ]);
    for (const target of Object.keys(useRemoteAccessStore.getState().verifiedExecutionTargetIds))
      if (saved.has(target) && !next[target])
        useRemoteAccessStore.getState().clearExecutionTargetVerified(target);
    previouslyAuthorizedTargets.clear();
    for (const { target } of projects) previouslyAuthorizedTargets.add(target);
  } catch (error) {
    if (token !== generation) return;
    // No cached target is selectable while reachability is unknown or the socket is down.
    useConnectedSshMonitorStore.setState({
      targets: {},
      projects: [],
      status: isWsTransportDisconnectedError(error) ? "disconnected" : "unavailable",
    });
    useRemoteMonitorStore.setState((state) =>
      Object.fromEntries(
        Object.entries(state).map(([target, current]) => [
          target,
          {
            ...current,
            snapshot: null,
            connection: "unavailable" as const,
            reason: "SSH connection status unavailable; reconnecting",
            history: { cpu: [], memory: [], network: [] },
          },
        ]),
      ),
    );
  } finally {
    if (token === generation && owners > 0) timer = setTimeout(() => void refresh(token), 5_000);
  }
}

/** One discovery loop per renderer; server owns shared SSH health and saved-workspace authorization. */
export function retainConnectedSshMonitorTargets(): () => void {
  owners++;
  if (owners === 1) void refresh(++generation);
  return () => {
    if (--owners > 0) return;
    generation++;
    if (timer) clearTimeout(timer);
    timer = undefined;
    previouslyAuthorizedTargets.clear();
    useConnectedSshMonitorStore.setState({ targets: {}, projects: [], status: "pending" });
  };
}
