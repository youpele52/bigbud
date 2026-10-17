import { Gauge } from "../ui/gauge";
import { cn } from "~/lib/utils";
import {
  capacityPercent,
  capacityUsageStatus,
  type CapacityUsage,
} from "./ResourceCapacityUsage.logic";
import { formatPercent } from "./resourceMonitor.format";

/** System memory keeps available/swap details without a redundant visible usage status. */
export function ResourceMemoryUsage({ usage }: { usage: CapacityUsage }) {
  const percent = capacityPercent(usage);
  return (
    <div className="space-y-3">
      <Gauge
        value={percent}
        label={`Memory capacity${percent === null ? " unavailable" : " used"}`}
        formatValue={formatPercent}
        description="of total host RAM"
        aria-valuetext={`${formatPercent(percent)} used · ${capacityUsageStatus(percent)}`}
      />
      <div
        className={cn("space-y-1 text-xs text-muted-foreground", percent === null && "text-center")}
      >
        {usage.footer.map((line) => (
          <p key={line} className="break-words">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
