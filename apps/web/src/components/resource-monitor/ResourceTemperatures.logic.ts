import type { MonitorNamedMetric } from "@bigbud/contracts/system-monitor/types";
import { readyTemperatureValue } from "~/stores/resource-monitor/resourceMonitor.temperature";

/** Only fresh measured sensors contribute to the hottest reading; ties preserve sensor order. */
export function hottestTemperature(
  sensors: readonly MonitorNamedMetric[],
  current: boolean,
): { name: string; value: number } | undefined {
  if (!current) return undefined;
  let hottest: { name: string; value: number } | undefined;
  for (const sensor of sensors) {
    const value = readyTemperatureValue(sensor.metric);
    if (value !== undefined && (!hottest || value > hottest.value))
      hottest = { name: sensor.name, value };
  }
  return hottest;
}
