import type { MonitorMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import {
  temperatureHistoryKey,
  type TemperatureHistory,
} from "~/stores/resource-monitor/resourceMonitor.temperatureHistory";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";

export function sensorMetric(
  value: number,
  status: MonitorMetric["status"] = "ready",
  sampledAtMs = 1000,
): MonitorMetric {
  return { value, status, sampledAtMs };
}

/** Raw native labels remain intact; an unthresholded hot chip is not automatically a warning. */
export function temperatureSnapshot(): MonitorSnapshot {
  return {
    ...appMonitorSnapshot(),
    temperaturesCelsius: [
      { name: "PMU TP2g", metric: sensorMetric(61.64) },
      { name: "PMU tdev8", metric: sensorMetric(58.98) },
      { name: "PMU TP3g", metric: sensorMetric(61.99) },
      { name: "gas gauge battery", metric: sensorMetric(37) },
      { name: "PMU tdev3", metric: sensorMetric(62.81) },
      { name: "PMU tdie10", metric: sensorMetric(61.28) },
    ],
    criticalTemperaturesCelsius: [
      { name: "gas gauge battery", metric: sensorMetric(45) },
      { name: "PMU TP2g", metric: sensorMetric(100, "unavailable") },
    ],
  };
}

export function sensorHistories(snapshot = temperatureSnapshot()): TemperatureHistory {
  return Object.fromEntries(
    snapshot.temperaturesCelsius.map((sensor) => [
      temperatureHistoryKey(sensor),
      Array.from({ length: 30 }, (_, sequence) => ({
        sequence,
        value: sensor.metric.value + Math.sin(sequence / 3) * 0.7,
      })),
    ]),
  );
}
