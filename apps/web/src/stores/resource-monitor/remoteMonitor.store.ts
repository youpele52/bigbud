import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import type { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import { create } from "zustand";
import { getWsRpcClient } from "~/rpc/wsRpcClient";
import type { HistoryPoint } from "./resourceMonitor.store";
import { appendTransferHistory } from "./resourceMonitor.history";

export interface RemoteMonitorState {
  snapshot: MonitorSnapshot | null;
  connection: "connecting" | "connected" | "unavailable";
  reason: string | null;
  history: Record<"cpu" | "memory" | "network", HistoryPoint[]>;
}
const empty = (): RemoteMonitorState => ({
  snapshot: null,
  connection: "connecting",
  reason: null,
  history: { cpu: [], memory: [], network: [] },
});
export const useRemoteMonitorStore = create<Record<string, RemoteMonitorState>>(() => ({}));
const owners = new Map<
  string,
  {
    count: number;
    projectIds: Map<string, number>;
    timer?: ReturnType<typeof setTimeout>;
    active: boolean;
    failures: number;
  }
>();

function append(history: HistoryPoint[], metric: number | undefined, sequence: number) {
  return metric === undefined ? history : [...history.slice(-299), { sequence, value: metric }];
}

async function sample(target: string, owner: NonNullable<ReturnType<typeof owners.get>>) {
  try {
    const projectId = owner.projectIds.keys().next().value;
    if (!projectId) return;
    const encoded = await getWsRpcClient().server.sampleSshMonitor({
      projectId: projectId as ProjectId,
    });
    if (!owner.active) return;
    const snapshot = JSON.parse(encoded) as MonitorSnapshot;
    if (
      (snapshot.summaryStatus !== "ready" && snapshot.summaryStatus !== "partial") ||
      typeof snapshot.sampledAtMs !== "number" ||
      !Array.isArray(snapshot.disks) ||
      !Array.isArray(snapshot.interfaces) ||
      Math.abs(Date.now() - snapshot.sampledAtMs) > 10_000
    )
      throw new Error("Remote sample is no longer current");
    owner.failures = 0;
    useRemoteMonitorStore.setState((state) => {
      const previous = state[target] ?? empty();
      const continuous =
        previous.snapshot?.sequence === snapshot.sequence - 1 &&
        previous.connection === "connected";
      const history = continuous ? previous.history : empty().history;
      return {
        ...state,
        [target]: {
          snapshot,
          connection: "connected",
          reason: null,
          history: {
            cpu: append(history.cpu, snapshot.cpuPercent?.value, snapshot.sequence),
            memory: append(history.memory, snapshot.memoryUsedBytes?.value, snapshot.sequence),
            network: appendTransferHistory(
              history.network,
              snapshot.networkReceivedBytesPerSecond?.value,
              snapshot.networkTransmittedBytesPerSecond?.value,
              snapshot.sequence,
            ),
          },
        },
      };
    });
  } catch (error) {
    if (!owner.active) return;
    owner.failures += 1;
    useRemoteMonitorStore.setState((state) => ({
      ...state,
      [target]: {
        ...empty(),
        connection: "unavailable",
        reason: error instanceof Error ? error.message : "SSH monitor unavailable",
      },
    }));
  } finally {
    if (owner.active)
      owner.timer = setTimeout(
        () => void sample(target, owner),
        owner.failures ? Math.min(30_000, 5_000 * 2 ** Math.min(owner.failures - 1, 3)) : 5_000,
      );
  }
}

/** A single poll loop per target across every mounted monitor surface. */
export function retainRemoteMonitor(target: string, projectId: string): () => void {
  let owner = owners.get(target);
  if (!owner) {
    owner = { count: 0, projectIds: new Map(), active: true, failures: 0 };
    owners.set(target, owner);
  }
  owner.count++;
  owner.projectIds.set(projectId, (owner.projectIds.get(projectId) ?? 0) + 1);
  if (owner.count === 1) void sample(target, owner);
  return () => {
    const references = owner.projectIds.get(projectId) ?? 0;
    if (references <= 1) owner.projectIds.delete(projectId);
    else owner.projectIds.set(projectId, references - 1);
    if (--owner.count > 0) return;
    owner.active = false;
    if (owner.timer) clearTimeout(owner.timer);
    owners.delete(target);
    useRemoteMonitorStore.setState((state) => {
      const next = { ...state };
      delete next[target];
      return next;
    }, true);
  };
}
