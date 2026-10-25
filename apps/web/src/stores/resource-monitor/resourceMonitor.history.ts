import type { HistoryPoint } from "./resourceMonitor.store";
import type { MonitorMetric } from "@bigbud/contracts/system-monitor/types";

/** Unknown, stale and invalid transfer rates are gaps, never zero activity. */
export function readyTransferValue(metric: MonitorMetric | undefined): number | undefined {
  return metric?.status === "ready" && Number.isFinite(metric.value) && metric.value >= 0
    ? metric.value
    : undefined;
}

/** Plot incoming transfers above zero and outgoing transfers below it, preserving missing rates. */
export function appendTransferHistory(
  points: HistoryPoint[],
  incoming: number | undefined,
  outgoing: number | undefined,
  sequence: number,
): HistoryPoint[] {
  const point = transferHistoryPoint(incoming, outgoing, sequence);
  return point ? [...points.slice(-299), point] : points;
}

/** Validate a mirrored transfer sample once for aggregate and named histories. */
export function transferHistoryPoint(
  incoming: number | undefined,
  outgoing: number | undefined,
  sequence: number,
): HistoryPoint | undefined {
  const safeIncoming = incoming !== undefined && Number.isFinite(incoming) ? incoming : undefined;
  const safeOutgoing = outgoing !== undefined && Number.isFinite(outgoing) ? outgoing : undefined;
  if (safeIncoming === undefined && safeOutgoing === undefined) return undefined;
  return {
    sequence,
    value: safeIncoming ?? null,
    // Negative outgoing values plot below the chart's zero baseline.
    sentValue: safeOutgoing === undefined ? null : -safeOutgoing,
  };
}
