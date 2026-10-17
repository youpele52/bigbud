import type { MonitorNamedMetric } from "@bigbud/contracts/system-monitor/types";
import { cpuUsageValue } from "./resourceMonitor.display.cpu";
import { formatPercent } from "./resourceMonitor.format";
import { capacityUsageStatus } from "./ResourceCapacityUsage.logic";
import { usagePercentColor } from "../ui/usageBands.logic";

/** Equal-scale core meters share usage colors with RAM, Swap and Disk capacity bars. */
export function ResourceCpuCore({ core, active }: { core: MonitorNamedMetric; active: boolean }) {
  const label = /^\d+$/.test(core.name) ? `Core ${core.name}` : core.name;
  const value = active ? cpuUsageValue(core.metric) : null;
  const status = active && core.metric.status !== "ready" ? core.metric.status : "Unavailable";
  return (
    <div
      role="group"
      aria-label={label}
      className="grid min-w-0 grid-cols-[minmax(0,4rem)_minmax(0,1fr)_4.5rem] items-center gap-2"
    >
      <span className="truncate text-xs text-muted-foreground" title={label}>
        {label}
      </span>
      <div
        role={value === null ? "img" : "meter"}
        aria-label={`${label} usage${value === null ? ` ${status.toLowerCase()}` : ""}`}
        title={value === null ? status : capacityUsageStatus(value)}
        {...(value === null
          ? {}
          : {
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuenow": value,
              "aria-valuetext": `${formatPercent(value)} · ${capacityUsageStatus(value)}`,
            })}
        className="h-1.5 min-w-0 overflow-hidden rounded-full bg-muted"
      >
        {value !== null ? (
          <div
            data-slot="cpu-core-fill"
            aria-hidden="true"
            className="h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${value}%`, backgroundColor: usagePercentColor(value) }}
          />
        ) : null}
      </div>
      <span className="text-right text-xs tabular-nums capitalize">
        {value === null ? status : formatPercent(value)}
      </span>
    </div>
  );
}
