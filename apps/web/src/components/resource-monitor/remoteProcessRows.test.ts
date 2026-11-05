import { expect, it } from "vitest";
import type { MonitorProcessRow } from "@bigbud/contracts/system-monitor/types";
import { remoteProcessRows } from "./remoteProcessRows";

it("finds a high-CPU row beyond the first 100 and sorts by reported CPU before paging", () => {
  const rows: MonitorProcessRow[] = Array.from({ length: 150 }, (_, index) => ({
    pid: index + 1,
    name: index === 149 ? "busy-worker" : "idle-worker",
    status: "S",
    startTimeSeconds: 1,
    runTimeSeconds: 1,
    residentBytes: 1,
    virtualBytes: 1,
    cpuPercent: { value: index === 149 ? 92 : 0, status: "ready", sampledAtMs: 1 },
  }));
  const controls = { search: "", sort: "cpu" as const, descending: true };
  expect(remoteProcessRows(rows, controls)[0]?.pid).toBe(150);
  expect(remoteProcessRows(rows, { ...controls, search: "busy" }).map((row) => row.pid)).toEqual([
    150,
  ]);
});
