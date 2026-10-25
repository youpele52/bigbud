import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceDisk } from "./ResourceDisk";
import { diskMetric, monitorDisk } from "./ResourceDisks.fixtures";
import { diskCapacityUsage } from "./resourceMonitor.display.disk";

describe("volume capacity and compact I/O", () => {
  it("reuses the Disk capacity bar and preserves volume metadata", () => {
    const markup = renderToStaticMarkup(<ResourceDisk disk={monitorDisk()} history={[]} active />);
    expect(markup).toContain("96.88%");
    expect(markup).toContain("496.00 GiB / 512.00 GiB");
    expect(markup).toContain("Critical usage");
    expect(markup).toContain("Free: 16.00 GiB");
    expect(markup).toContain("/ · apfs");
    expect(markup).toContain("Fixed");
    expect(markup).toContain("Read only");
    expect(markup).toContain("6.00 KiB/s");
    expect(markup).toContain("18.00 KiB/s");
    expect(markup).toContain("size-3");
    expect(markup).toContain("Waiting for I/O history");
  });
  it("does not show old I/O values or loading activity while disconnected", () => {
    const markup = renderToStaticMarkup(
      <ResourceDisk
        disk={monitorDisk()}
        history={[
          { sequence: 1, value: 10 },
          { sequence: 2, value: 20 },
        ]}
        active={false}
      />,
    );
    expect(markup).toContain("Disk I/O unavailable");
    expect(markup).not.toContain("6.00 KiB/s");
    expect(markup).not.toContain("animate-breathe");
    expect(markup).not.toContain("I/O history");
  });
  it("uses measured used bytes even when free space is not available", () => {
    const withoutFree = monitorDisk();
    delete withoutFree.freeBytes;
    const withoutUsed = monitorDisk();
    delete withoutUsed.usedBytes;
    expect(diskCapacityUsage(withoutFree).usedBytes).toBe(496 * 1024 ** 3);
    expect(diskCapacityUsage(withoutUsed).usedBytes).toBe(496 * 1024 ** 3);
    expect(
      diskCapacityUsage({ ...monitorDisk(), usedBytes: diskMetric(0, "stale") }).usedBytes,
    ).toBeNull();
  });
  it("renders unknown totals as unavailable rather than a false zero", () => {
    const disk = monitorDisk();
    delete disk.totalBytes;
    delete disk.readBytesPerSecond;
    delete disk.writtenBytesPerSecond;
    const markup = renderToStaticMarkup(<ResourceDisk disk={disk} history={[]} active />);
    expect(markup).toContain("Usage unavailable");
    expect(markup).toContain("496.00 GiB / —");
    expect(markup).toContain("Disk I/O unavailable");
    expect(markup).not.toContain("animate-breathe");
  });
});
