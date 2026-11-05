import { useEffect } from "react";
import {
  retainRemoteMonitor,
  useRemoteMonitorStore,
} from "~/stores/resource-monitor/remoteMonitor.store";

export function useRemoteMonitor(target: string | null, projectId: string | null) {
  useEffect(
    () => (target && projectId ? retainRemoteMonitor(target, projectId) : undefined),
    [target, projectId],
  );
  return useRemoteMonitorStore((state) => (target ? state[target] : undefined));
}
