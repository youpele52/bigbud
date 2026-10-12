import { cn } from "~/lib/utils";
import { CenteredStatus } from "../common/CenteredStatus";
import { usagePercentColor } from "../ui/usageBands.logic";
import { formatPercent } from "./resourceMonitor.format";
import {
  capacityPercent,
  capacityUsageStatus,
  formatCapacityGiB,
  type CapacityUsage,
} from "./ResourceCapacityUsage.logic";

export function ResourceCapacityUsage({
  usage,
  label,
  large = false,
  allowOverCapacity = false,
  loading = false,
  unavailableLabel,
}: {
  usage: CapacityUsage;
  label: string;
  large?: boolean;
  allowOverCapacity?: boolean;
  loading?: boolean;
  unavailableLabel?: string;
}) {
  const percent = capacityPercent(usage, allowOverCapacity);
  const status =
    percent !== null && percent > 100 ? "Usage exceeds capacity" : capacityUsageStatus(percent);
  const color = usagePercentColor(percent);
  return (
    <div className={cn("space-y-3", large && "py-1")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xl font-semibold tabular-nums" style={{ color }}>
          {formatPercent(percent)}{" "}
          <span className="text-xs font-normal text-muted-foreground">used</span>
        </p>
        <span
          aria-label={`${formatCapacityGiB(usage.usedBytes)} used of ${formatCapacityGiB(usage.totalBytes)} total`}
          className="text-xs tabular-nums"
        >
          {formatCapacityGiB(usage.usedBytes)} / {formatCapacityGiB(usage.totalBytes)}
        </span>
      </div>
      <div
        role={percent === null ? "img" : "meter"}
        aria-label={`${label} capacity${percent === null ? " unavailable" : " used"}`}
        {...(percent === null
          ? {}
          : {
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuenow": Math.min(percent, 100),
              "aria-valuetext": `${formatPercent(percent)} used · ${status}`,
            })}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        {percent !== null ? (
          <div
            aria-hidden="true"
            className="h-full rounded-full"
            style={{ width: `${Math.min(percent, 100)}%`, backgroundColor: color }}
          />
        ) : null}
      </div>
      {percent === null ? (
        <CenteredStatus loading={loading}>
          {loading ? "Waiting for capacity data" : (unavailableLabel ?? status)}
        </CenteredStatus>
      ) : (
        <p className="text-xs" style={{ color }}>
          {status}
        </p>
      )}
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
