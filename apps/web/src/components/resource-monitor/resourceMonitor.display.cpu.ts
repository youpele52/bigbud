import type { MonitorMetric } from "@bigbud/contracts/system-monitor/types";
import { capacityValue } from "./ResourceCapacityUsage.logic";

/** CPU readings share a fixed 0–100% scale; invalid or non-current samples stay unknown. */
export function cpuUsageValue(metric: MonitorMetric | undefined): number | null {
  const value = capacityValue(metric);
  return value !== null && value <= 100 ? value : null;
}
