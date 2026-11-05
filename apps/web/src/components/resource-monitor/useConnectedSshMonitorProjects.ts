import { useEffect } from "react";
import {
  retainConnectedSshMonitorTargets,
  useConnectedSshMonitorStore,
} from "~/stores/resource-monitor/remoteMonitor.connections.store";

export function useConnectedSshMonitorProjects(visible = true) {
  useEffect(() => (visible ? retainConnectedSshMonitorTargets() : undefined), [visible]);
  return useConnectedSshMonitorStore((state) => state.projects);
}
