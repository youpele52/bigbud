import type {
  MonitorDisk,
  MonitorMetric,
  MonitorSnapshot,
} from "@bigbud/contracts/system-monitor/types";
import { describe, expect, it } from "vitest";

import { displayWidget } from "./resourceMonitor.display";

const metric = (value: number, status: MonitorMetric["status"] = "ready"): MonitorMetric => ({
  value,
  status,
  sampledAtMs: 1,
});
const disk = (name: string, mount: string): MonitorDisk => ({
  name,
  mount,
  filesystem: "apfs",
  totalBytes: metric(500 * 1024 ** 3),
  freeBytes: metric(310 * 1024 ** 3),
});
const display = (disks: MonitorDisk[], capacity = metric(900 * 1024 ** 3)) =>
  displayWidget({ disks, diskCapacityBytes: capacity } as MonitorSnapshot, "disk");

describe("Disk resource widget", () => {
  it("pairs one volume's free space with its total rather than aggregate capacity", () => {
    expect(display([disk("Macintosh HD", "/")])).toMatchObject({
      label: "Disk",
      value: "310.00 GiB free",
      status: "ready",
      detail: "500.00 GiB total · Macintosh HD",
    });
  });

  it("uses volume metrics when aggregate capacity is unavailable", () => {
    expect(display([disk("Macintosh HD", "/")], metric(0, "unavailable"))).toMatchObject({
      value: "310.00 GiB free",
      detail: "500.00 GiB total · Macintosh HD",
    });
  });

  it("selects the root volume without summing potentially duplicated mounts", () => {
    expect(
      display([disk("Data", "/System/Volumes/Data"), disk("Macintosh HD", "/")]),
    ).toMatchObject({
      value: "310.00 GiB free",
      detail: "500.00 GiB total · Macintosh HD (/)",
    });
  });

  it("selects by mount path consistently when no root volume is reported", () => {
    const volumes = [disk("External", "D:\\"), disk("System", "C:\\")];
    expect(display(volumes)).toEqual(display(volumes.toReversed()));
    expect(display(volumes).detail).toBe("500.00 GiB total · System (C:\\)");
    expect(volumes[0]?.name).toBe("External");
  });

  it.each(["warming", "stale", "denied", "unavailable"] as const)(
    "does not display %s free space as current",
    (status) => {
      expect(display([{ ...disk("Disk", "/"), freeBytes: metric(100, status) }])).toMatchObject({
        value: "— free",
        status,
        detail: "500.00 GiB total · Disk",
      });
    },
  );

  it("preserves real zero free space and missing total availability", () => {
    const volume = { ...disk("Disk", "/"), freeBytes: metric(0) };
    delete volume.totalBytes;
    expect(display([volume])).toMatchObject({
      value: "0.00 B free",
      status: "unavailable",
      detail: "— total · Disk",
    });
  });

  it.each([0, 310, 500])("charts valid free space of %i GiB", (free) => {
    expect(
      display([{ ...disk("Disk", "/"), freeBytes: metric(free * 1024 ** 3) }]).diskUsage,
    ).toEqual({ totalBytes: 500 * 1024 ** 3, freeBytes: free * 1024 ** 3 });
  });

  it.each([-1, 501 * 1024 ** 3, NaN, Infinity])(
    "omits the chart for invalid free space %s",
    (free) => {
      expect(
        display([{ ...disk("Disk", "/"), freeBytes: metric(free) }]).diskUsage,
      ).toBeUndefined();
    },
  );

  it("omits the chart for stale samples and zero capacity", () => {
    expect(
      display([{ ...disk("Disk", "/"), freeBytes: metric(10, "stale") }]).diskUsage,
    ).toBeUndefined();
    expect(display([{ ...disk("Disk", "/"), totalBytes: metric(0) }]).diskUsage).toBeUndefined();
  });

  it("keeps missing free space unavailable even when total capacity is known", () => {
    const volume = disk("Disk", "/");
    delete volume.freeBytes;
    expect(display([volume])).toMatchObject({
      value: "— free",
      status: "unavailable",
    });
    expect(display([])).toMatchObject({
      value: "— free",
      status: "unavailable",
      detail: "900.00 GiB total · Free space unavailable",
    });
  });
});
