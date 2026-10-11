import { cn } from "~/lib/utils";
import { formatPercent } from "./resourceMonitor.format";
import {
  capacityPercent,
  capacitySeverity,
  formatCapacityGiB,
  type CapacityUsage,
} from "./ResourceCapacityUsage.logic";

export function ResourceCapacityUsage({
  usage,
  label,
  large = false,
}: {
  usage: CapacityUsage;
  label: string;
  large?: boolean;
}) {
  const percent = capacityPercent(usage);
  const severity = capacitySeverity(percent);
  const status =
    severity === "critical"
      ? "Critical usage"
      : severity === "warning"
        ? "High usage"
        : severity === "neutral"
          ? "Normal usage"
          : "Usage unavailable";
  const color =
    severity === "critical"
      ? "text-red-600 dark:text-red-400"
      : severity === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <div className={cn("space-y-3", large && "py-1")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={cn("text-xl font-semibold tabular-nums", color)}>
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
              "aria-valuenow": percent,
              "aria-valuetext": `${formatPercent(percent)} used · ${status}`,
            })}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        {percent !== null ? (
          <div
            aria-hidden="true"
            className={cn(
              "h-full rounded-full",
              severity === "critical"
                ? "bg-red-500"
                : severity === "warning"
                  ? "bg-amber-500"
                  : "bg-primary/70",
            )}
            style={{ width: `${percent}%` }}
          />
        ) : null}
      </div>
      <p className={cn("text-xs", percent === null ? "text-muted-foreground" : color)}>{status}</p>
      <div className="space-y-1 text-xs text-muted-foreground">
        {usage.footer.map((line, index) => (
          <p key={index} className="break-words">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
