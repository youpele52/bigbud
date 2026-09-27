import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { describe, expect, it } from "vitest";

import { displayWidget } from "./resourceMonitor.display";

describe("Disk resource widget", () => {
  it("shows a named disk when the combined capacity is unavailable", () => {
    const snapshot = {
      diskCapacityBytes: { value: 0, status: "unavailable", sampledAtMs: 1 },
      disks: [
        {
          name: "Macintosh HD",
          totalBytes: { value: 494_384_795_648, status: "ready", sampledAtMs: 1 },
        },
      ],
    } as MonitorSnapshot;

    expect(displayWidget(snapshot, "disk")).toMatchObject({
      value: "460.4 GiB",
      status: "ready",
      detail: "Macintosh HD capacity",
    });
  });

  it("keeps an unavailable state when no disk is reported", () => {
    const snapshot = {
      diskCapacityBytes: { value: 0, status: "unavailable", sampledAtMs: 1 },
      disks: [],
    } as unknown as MonitorSnapshot;

    expect(displayWidget(snapshot, "disk")).toMatchObject({
      value: "—",
      status: "unavailable",
      detail: "Combined capacity",
    });
  });

  it("does not present one of several disks as a combined capacity", () => {
    const snapshot = {
      diskCapacityBytes: { value: 0, status: "unavailable", sampledAtMs: 1 },
      disks: [
        { name: "One", totalBytes: { value: 100, status: "ready", sampledAtMs: 1 } },
        { name: "Two", totalBytes: { value: 200, status: "ready", sampledAtMs: 1 } },
      ],
    } as MonitorSnapshot;

    expect(displayWidget(snapshot, "disk")).toMatchObject({
      value: "—",
      status: "unavailable",
      detail: "Combined capacity",
    });
  });
});
