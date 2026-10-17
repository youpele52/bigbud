import { useEffect, useId } from "react";

import {
  setResourceMonitorConsumer,
  useResourceMonitorStore,
} from "~/stores/resource-monitor/resourceMonitor.store";

export function useResourceMonitor(
  visible: boolean,
  processes: boolean,
  sensors: boolean,
  appResources = false,
) {
  const id = useId();
  useEffect(() => {
    setResourceMonitorConsumer(
      id,
      visible
        ? { processes, disks: !appResources, sensors, ...(appResources ? { appResources } : {}) }
        : null,
    );
  }, [id, processes, sensors, visible, appResources]);
  useEffect(() => {
    return () => setResourceMonitorConsumer(id, null);
  }, [id]);
  return useResourceMonitorStore();
}
