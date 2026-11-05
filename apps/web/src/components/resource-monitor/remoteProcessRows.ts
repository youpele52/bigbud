import type { MonitorProcessRow } from "@bigbud/contracts/system-monitor/types";
import type { ProcessQueryControls } from "./ProcessTable";

/** Sort and search the bounded SSH inventory before paging its visible rows. */
export function remoteProcessRows(
  rows: readonly MonitorProcessRow[],
  controls: ProcessQueryControls,
): MonitorProcessRow[] {
  const query = controls.search.toLowerCase();
  return rows
    .filter((row) => `${row.name} ${row.pid} ${row.status}`.toLowerCase().includes(query))
    .toSorted((left, right) => {
      const comparison =
        controls.sort === "name"
          ? left.name.localeCompare(right.name)
          : controls.sort === "pid"
            ? left.pid - right.pid
            : controls.sort === "memory"
              ? left.residentBytes - right.residentBytes
              : (left.cpuPercent?.value ?? -1) - (right.cpuPercent?.value ?? -1);
      return (controls.descending ? -1 : 1) * (comparison || left.pid - right.pid);
    });
}
