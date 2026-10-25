import type { MonitorMetric } from "@bigbud/contracts/system-monitor/types";

/** Celsius readings may be negative or zero; stale, nonfinite and impossible readings are unknown. */
export function readyTemperatureValue(metric: MonitorMetric | undefined): number | undefined {
  return metric?.status === "ready" && Number.isFinite(metric.value) && metric.value >= -273.15
    ? metric.value
    : undefined;
}
