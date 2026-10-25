import type { MonitorNamedMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { nextEntityHistory, type EntityHistory } from "./resourceMonitor.entityHistory";
import { readyTemperatureValue } from "./resourceMonitor.temperature";

export type TemperatureHistory = EntityHistory;

/** Encode native sensor identities without colliding with object prototype names. */
export function temperatureHistoryKey(sensor: MonitorNamedMetric): string {
  return JSON.stringify([sensor.name]);
}

/** Keep independent sensor histories; never derive temperatures or duplicate slower sensor samples. */
export function nextTemperatureHistory(
  previous: MonitorSnapshot | null,
  snapshot: MonitorSnapshot,
  history: TemperatureHistory,
  continuous: boolean,
): TemperatureHistory {
  if (snapshot.summaryStatus !== "ready") return {};
  const entities = (sensors: readonly MonitorNamedMetric[]) =>
    sensors.map((sensor) => ({ key: temperatureHistoryKey(sensor), metrics: [sensor.metric] }));
  return nextEntityHistory(
    entities(previous?.temperaturesCelsius ?? []),
    entities(snapshot.temperaturesCelsius),
    history,
    snapshot.sequence,
    continuous,
    (metrics, sequence) => {
      const value = readyTemperatureValue(metrics[0]);
      return value === undefined ? undefined : { sequence, value };
    },
  );
}
