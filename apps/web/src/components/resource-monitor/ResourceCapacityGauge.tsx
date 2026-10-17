import { Gauge } from "../ui/gauge";
import { capacityDonutData, type CapacityUsage } from "./ResourceCapacityDonut.logic";
import { formatPercent } from "./resourceMonitor.format";

/** Preserve estimated memory shares above 100% while bounding only the drawn needle. */
export function ResourceCapacityGauge({
  usage,
  kind,
}: {
  usage: CapacityUsage | undefined;
  kind: "cpu" | "memory";
}) {
  const data =
    kind === "cpu" && (usage?.total !== 100 || usage.used > 100)
      ? undefined
      : capacityDonutData(usage);
  const value = data?.percentage;
  const label = kind === "cpu" ? "CPU" : "Memory";
  const capacity = kind === "cpu" ? "host CPU" : "host RAM";
  return (
    <div className="min-w-0 space-y-2">
      <Gauge
        value={value}
        label={`${label} capacity: ${value === undefined ? "unavailable" : `${formatPercent(value)} core bigbud of total ${capacity}`}`}
        formatValue={formatPercent}
        valueText={formatPercent(value)}
        description={
          value === undefined ? "Host capacity share unavailable" : `of total ${capacity}`
        }
      />
      {kind === "memory" && data?.exceedsCapacity ? (
        <p className="text-xs text-amber-600">
          Estimate exceeds host RAM; shared pages may be counted more than once.
        </p>
      ) : null}
    </div>
  );
}
