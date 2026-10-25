import type { MonitorMetric, MonitorNamedMetric } from "@bigbud/contracts/system-monitor/types";
import type { HistoryPoint } from "~/stores/resource-monitor/resourceMonitor.store";
import { ResourceDetailDialog } from "./ResourceDetailDialog";
import { ResourceTemperatureContent } from "./ResourceTemperatureContent";

/** Keep compact and expanded sensor views live through the same props and shared dialog. */
export function ResourceTemperature({
  sensor,
  critical,
  history,
  current,
  loading,
}: {
  sensor: MonitorNamedMetric;
  critical: MonitorMetric | undefined;
  history: HistoryPoint[];
  current: boolean;
  loading: boolean;
}) {
  return (
    <ResourceDetailDialog
      title={`${sensor.name} temperature sensor`}
      description={`Live temperature history and reported threshold for ${sensor.name}.`}
      expandedContent={
        <ResourceTemperatureContent
          sensor={sensor}
          critical={critical}
          history={history}
          current={current}
          loading={loading}
          expanded
        />
      }
    >
      {(trigger) => (
        <ResourceTemperatureContent
          sensor={sensor}
          critical={critical}
          history={history}
          current={current}
          loading={loading}
          headerAction={trigger}
        />
      )}
    </ResourceDetailDialog>
  );
}
