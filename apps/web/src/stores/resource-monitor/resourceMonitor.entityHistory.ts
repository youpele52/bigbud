import type { MonitorMetric } from "@bigbud/contracts/system-monitor/types";
import { transferHistoryPoint, readyTransferValue } from "./resourceMonitor.history";
import type { HistoryPoint } from "./resourceMonitor.store";

export type EntityHistory = Record<string, HistoryPoint[]>;
export type EntityTransferHistory = EntityHistory;
export interface MetricEntity {
  key: string;
  metrics: readonly (MonitorMetric | undefined)[];
}
export interface TransferEntity {
  key: string;
  incoming: MonitorMetric | undefined;
  outgoing: MonitorMetric | undefined;
}

function sameSample(previous: MonitorMetric | undefined, next: MonitorMetric | undefined): boolean {
  return (
    previous?.sampledAtMs === next?.sampledAtMs &&
    previous?.status === next?.status &&
    previous?.value === next?.value
  );
}

function transferEntities(items: readonly TransferEntity[]): MetricEntity[] {
  return items.map((item) => ({ key: item.key, metrics: [item.incoming, item.outgoing] }));
}

/** Bound named transfer histories, prune removed entities, and avoid repeating slower samples. */
export function nextEntityTransferHistory(
  previous: readonly TransferEntity[],
  entities: readonly TransferEntity[],
  history: EntityTransferHistory,
  sequence: number,
  continuous: boolean,
): EntityTransferHistory {
  return nextEntityHistory(
    transferEntities(previous),
    transferEntities(entities),
    history,
    sequence,
    continuous,
    (metrics, sampleSequence) =>
      transferHistoryPoint(
        readyTransferValue(metrics[0]),
        readyTransferValue(metrics[1]),
        sampleSequence,
      ),
  );
}

/** Share bounded sample lifecycle across transfers and scalar sensors without inventing samples. */
export function nextEntityHistory(
  previous: readonly MetricEntity[],
  entities: readonly MetricEntity[],
  history: EntityHistory,
  sequence: number,
  continuous: boolean,
  sample: (metrics: MetricEntity["metrics"], sequence: number) => HistoryPoint | undefined,
): EntityHistory {
  const oldEntities = new Map(previous.map((entity) => [entity.key, entity]));
  const next: EntityHistory = {};
  for (const entity of entities) {
    const point = sample(entity.metrics, sequence);
    if (!point) continue;
    const old = oldEntities.get(entity.key);
    const metrics = entity.metrics;
    const oldMetrics = old?.metrics ?? [];
    const fresh = metrics.every(
      (metric, index) =>
        metric?.status !== "stale" &&
        oldMetrics[index]?.status !== "stale" &&
        (metric === undefined ||
          oldMetrics[index] === undefined ||
          metric.sampledAtMs >= oldMetrics[index]!.sampledAtMs),
    );
    const points = continuous && fresh ? (history[entity.key] ?? []) : [];
    next[entity.key] =
      continuous &&
      fresh &&
      points.length > 0 &&
      old &&
      metrics.every((metric, index) => sameSample(oldMetrics[index], metric))
        ? points
        : [...points.slice(-299), point];
  }
  return next;
}
