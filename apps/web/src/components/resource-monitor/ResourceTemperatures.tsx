import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import {
  temperatureHistoryKey,
  type TemperatureHistory,
} from "~/stores/resource-monitor/resourceMonitor.temperatureHistory";
import { readyTemperatureValue } from "~/stores/resource-monitor/resourceMonitor.temperature";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CenteredStatus } from "../common/CenteredStatus";
import { ResourceMetricBadge } from "./ResourceMetricBadge";
import { ResourceTemperature } from "./ResourceTemperature";
import { hottestTemperature } from "./ResourceTemperatures.logic";
import { formatTemperature } from "./resourceMonitor.format";

/** Two compact sensors per wide row, stable by native name rather than changing temperature. */
export function ResourceTemperatures({
  snapshot,
  history,
  current,
  loading,
}: {
  snapshot: MonitorSnapshot | null;
  history: TemperatureHistory;
  current: boolean;
  loading: boolean;
}) {
  const sensors = (snapshot?.temperaturesCelsius ?? []).toSorted((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true }),
  );
  const critical = new Map(
    snapshot?.criticalTemperaturesCelsius?.map((sensor) => [sensor.name, sensor.metric]),
  );
  const hottest = hottestTemperature(sensors, current);
  const unknownThresholds =
    current &&
    sensors.some((sensor) => readyTemperatureValue(critical.get(sensor.name)) === undefined);
  return (
    <Card role="region" aria-label="Temperatures" className="@container min-w-0 gap-2 py-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4">
        <CardTitle className="text-sm">Temperatures</CardTitle>
        <ResourceMetricBadge title={hottest?.name}>
          Hottest: {formatTemperature(hottest?.value)}
        </ResourceMetricBadge>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3 px-4">
        {sensors.length ? (
          <div className="grid grid-cols-1 items-start gap-3 @min-[640px]:grid-cols-2">
            {sensors.map((sensor) => (
              <ResourceTemperature
                key={sensor.name}
                sensor={sensor}
                critical={critical.get(sensor.name)}
                history={history[temperatureHistoryKey(sensor)] ?? []}
                current={current}
                loading={loading}
              />
            ))}
          </div>
        ) : (
          <CenteredStatus loading={loading} className="min-h-24">
            {loading
              ? "Waiting for temperature sensors"
              : "No supported temperature sensor reported"}
          </CenteredStatus>
        )}
        {unknownThresholds ? (
          <p className="text-xs text-muted-foreground">
            Some sensors do not report critical thresholds. Chart colors do not indicate safety;
            warnings require a reported critical threshold.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
