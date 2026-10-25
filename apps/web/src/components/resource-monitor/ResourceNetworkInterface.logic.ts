import type { MonitorMetric, MonitorTextField } from "@bigbud/contracts/system-monitor/types";
import { readyTransferValue } from "~/stores/resource-monitor/resourceMonitor.history";

/** Keep unknown counters distinct from genuine measured zeroes. */
export function interfaceMetricText(
  metric: MonitorMetric | undefined,
  format: (value: number) => string,
): string {
  const value = readyTransferValue(metric);
  return value === undefined ? "—" : format(value);
}

/** Report native link state without guessing connection type from interface names. */
export function interfaceLinkText(field: MonitorTextField | undefined, current: boolean): string {
  if (!current) return "Link unavailable";
  return `Link ${field?.status === "ready" && field.value ? field.value : (field?.status ?? "unavailable")}`;
}
