import type { MonitorNamedMetric } from "@bigbud/contracts/system-monitor/types";

/** A representative uneven ten-core load, kept in collector order. */
export function cpuCoreReadings(): MonitorNamedMetric[] {
  return [100, 100, 89.52, 60.4, 39.22, 29.41, 38.83, 15.53, 11.54, 5.83].map((value, index) => ({
    name: String(index),
    metric: { value, status: "ready", sampledAtMs: 1000 },
  }));
}
