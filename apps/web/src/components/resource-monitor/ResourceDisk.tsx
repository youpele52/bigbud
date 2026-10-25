import type { MonitorDisk } from "@bigbud/contracts/system-monitor/types";
import type { HistoryPoint } from "~/stores/resource-monitor/resourceMonitor.store";
import { diskRateValue } from "~/stores/resource-monitor/resourceMonitor.diskHistory";
import { CenteredStatus } from "../common/CenteredStatus";
import { isLoadingStatus } from "../common/CenteredStatus.logic";
import { ResourceCapacityUsage } from "./ResourceCapacityUsage";
import { ResourceTransferRates } from "./ResourceTransferRates";
import { ResourceMetricHistory } from "./ResourceMetricHistory";
import { diskCapacityUsage } from "./resourceMonitor.display.disk";
import { formatRate } from "./resourceMonitor.format";

/** One wide volume row pairs the shared capacity bar with compact, mirrored disk I/O. */
export function ResourceDisk({
  disk,
  history,
  active,
}: {
  disk: MonitorDisk;
  history: HistoryPoint[];
  active: boolean;
}) {
  const name = disk.name || disk.mount;
  const usage = diskCapacityUsage(disk);
  const read = active ? diskRateValue(disk.readBytesPerSecond) : undefined;
  const written = active ? diskRateValue(disk.writtenBytesPerSecond) : undefined;
  const waiting =
    active &&
    [disk.readBytesPerSecond, disk.writtenBytesPerSecond].some(
      (metric) =>
        diskRateValue(metric) !== undefined || isLoadingStatus(metric?.status ?? "unavailable"),
    );
  return (
    <section
      aria-label={`${name} (${disk.mount}) disk`}
      className="@container min-w-0 rounded-xl border p-3"
    >
      <div className="grid min-w-0 gap-4 @min-[640px]:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="min-w-0 space-y-3">
          <div className="min-w-0">
            <h3 className="break-words text-sm font-medium">{name}</h3>
            <p className="break-words text-xs text-muted-foreground">
              {disk.mount} · {disk.filesystem || "Filesystem unavailable"}
            </p>
          </div>
          <ResourceCapacityUsage
            usage={{ ...usage, footer: usage.footer.slice(0, 1) }}
            label={`${name} (${disk.mount})`}
          />
          <p className="text-xs text-muted-foreground">
            {disk.removable?.status === "ready"
              ? disk.removable.value
                ? "Removable"
                : "Fixed"
              : "Removable status unavailable"}
            {" · "}
            {disk.readOnly?.status === "ready"
              ? disk.readOnly.value
                ? "Read only"
                : "Writable"
              : "Write status unavailable"}
          </p>
        </div>
        <div
          data-slot="disk-io-panel"
          className="grid min-h-40 min-w-0 grid-rows-2 border-t pt-3 @min-[640px]:border-t-0 @min-[640px]:border-l @min-[640px]:pt-0 @min-[640px]:pl-4"
        >
          <div data-slot="disk-io-readings" className="flex min-h-0 items-center">
            <ResourceTransferRates
              kind="io"
              incoming={formatRate(read)}
              outgoing={formatRate(written)}
              compact
            />
          </div>
          {active && (read !== undefined || written !== undefined) && history.length > 1 ? (
            <ResourceMetricHistory
              fill
              metric={{
                label: `${name} (${disk.mount}) I/O`,
                value: "",
                status: "ready",
                history,
                historyStyle: "io",
                historyValueFormatter: formatRate,
              }}
            />
          ) : (
            <CenteredStatus loading={waiting} className="h-full min-h-0">
              {waiting ? "Waiting for I/O history" : "Disk I/O unavailable"}
            </CenteredStatus>
          )}
        </div>
      </div>
    </section>
  );
}
