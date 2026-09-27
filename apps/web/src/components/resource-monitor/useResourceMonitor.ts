import { useEffect, useId } from "react";

import {
  setResourceMonitorConsumer,
  useResourceMonitorStore,
} from "~/stores/resource-monitor/resourceMonitor.store";

export function useResourceMonitor(visible: boolean, processes: boolean, sensors: boolean) {
  const id = useId();
  useEffect(() => {
    setResourceMonitorConsumer(id, visible ? { processes, disks: true, sensors } : null);
  }, [id, processes, sensors, visible]);
  useEffect(() => {
    return () => setResourceMonitorConsumer(id, null);
  }, [id]);
  return useResourceMonitorStore();
}
