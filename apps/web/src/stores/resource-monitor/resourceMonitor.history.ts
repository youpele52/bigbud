import type { HistoryPoint } from "./resourceMonitor.store";

/** Plot incoming transfers above zero and outgoing transfers below it, preserving missing rates. */
export function appendTransferHistory(
  points: HistoryPoint[],
  incoming: number | undefined,
  outgoing: number | undefined,
  sequence: number,
): HistoryPoint[] {
  const safeIncoming = incoming !== undefined && Number.isFinite(incoming) ? incoming : undefined;
  const safeOutgoing = outgoing !== undefined && Number.isFinite(outgoing) ? outgoing : undefined;
  if (safeIncoming === undefined && safeOutgoing === undefined) return points;
  return [
    ...points.slice(-299),
    {
      sequence,
      value: safeIncoming ?? null,
      // Negative outgoing values plot below the chart's zero baseline.
      sentValue: safeOutgoing === undefined ? null : -safeOutgoing,
    },
  ];
}
