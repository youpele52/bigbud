import { describe, expect, it } from "vitest";
import { parseSshMonitor } from "./sshMonitor.parse.ts";

const output = `###OS###
Linux
###HOST###
vps-1
###ARCH###
x86_64
###KERNEL###
6.1.0
###CPU1###
cpu 100 0 100 800 0 0 0 0 0 0
cpu0 50 0 50 400 0 0 0 0 0 0
###CPU2###
cpu 125 0 125 850 0 0 0 0 0 0
###MEM###
MemTotal: 4096 kB
MemAvailable: 1024 kB
SwapTotal: 2048 kB
SwapFree: 1536 kB
###UPTIME###
1234.5 3.0
###DF###
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 10000 2000 8000 20% /
###NET###
Inter-|   Receive | Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
 eth0: 1024 1 0 0 0 0 0 0 2048 1 0 0 0 0 0 0
###PROCESS###
1 0 init 1024 2048 S 1200
###TEMP###
/sys/class/thermal/thermal_zone0/temp 42000
###END###
`;

describe("read-only Linux SSH monitor parsing", () => {
  it("computes CPU from two samples and reads memory, disk, network and exposed sensors", () => {
    const snapshot = parseSshMonitor(output, 123456, 1);
    expect(snapshot.cpuPercent?.value).toBe(50);
    expect(snapshot.memoryUsedBytes?.value).toBe(3072 * 1024);
    expect(snapshot.swapUsedBytes?.value).toBe(512 * 1024);
    expect(snapshot.disks[0]?.mount).toBe("/");
    expect(snapshot.interfaces[0]?.receivedTotalBytes?.value).toBe(1024);
    expect(snapshot.processRows?.[0]).toMatchObject({
      pid: 1,
      name: "init",
      residentBytes: 1024 * 1024,
    });
    expect(snapshot.processRows?.[0]?.diskReadBytes).toBeUndefined();
    expect(snapshot.temperaturesCelsius[0]?.metric.value).toBe(42);
    expect(snapshot.appResources).toBeUndefined();
  });

  it("rejects incomplete and unsupported OS reads rather than displaying them as live", () => {
    expect(() => parseSshMonitor(output.replace("###END###", ""), 1, 1)).toThrow("Incomplete");
    expect(() => parseSshMonitor(output.replace("Linux", "FreeBSD"), 1, 1)).toThrow("Unsupported");
  });

  it("marks failed optional commands partial and never presents missing disk, network or processes as ready", () => {
    const failed = output.replace(
      /###DF###[\s\S]*?###TEMP###/u,
      "###DF###\n###NET###\n###PROCESS###\n###TEMP###",
    );
    const snapshot = parseSshMonitor(failed, 123456, 1);
    expect(snapshot.summaryStatus).toBe("partial");
    expect(snapshot.cpuPercent?.status).toBe("ready");
    expect(snapshot.diskCapacityBytes?.status).toBe("unavailable");
    expect(snapshot.networkReceivedBytesPerSecond?.status).toBe("unavailable");
    expect(snapshot.processStatus).toBe("unavailable");
  });

  it("preserves the root disk if it occurs beyond the display cap", () => {
    const disks = Array.from(
      { length: 68 },
      (_, index) => `/dev/volume${index} 100 30 70 30% /mnt/${index}`,
    ).join("\n");
    const crowded = output.replace(
      "/dev/vda1 10000 2000 8000 20% /",
      `${disks}\n/dev/root 1000 200 800 20% /`,
    );
    const snapshot = parseSshMonitor(crowded, 123456, 1);
    expect(snapshot.disks).toHaveLength(64);
    expect(snapshot.disksTruncated).toBe(true);
    expect(snapshot.disks.find((disk) => disk.mount === "/")?.name).toBe("/dev/root");
    expect(snapshot.diskCapacityBytes?.value).toBe(1000 * 1024);
  });

  it("does not present an unrelated mount as primary capacity when root is absent", () => {
    const snapshot = parseSshMonitor(
      output.replace("/dev/vda1 10000 2000 8000 20% /", "/dev/data 10000 2000 8000 20% /data"),
      123456,
      1,
    );
    expect(snapshot.disks[0]?.mount).toBe("/data");
    expect(snapshot.diskCapacityBytes?.status).toBe("unavailable");
    expect(snapshot.summaryStatus).toBe("partial");
  });

  it("parses CPU for a bounded process inventory and reports overflow honestly", () => {
    const rows = Array.from(
      { length: 1_001 },
      (_, index) => `${index + 1} 0 worker 1024 2048 S 1200 ${index === 999 ? "95.5" : "0.0"}`,
    ).join("\n");
    const snapshot = parseSshMonitor(output.replace("1 0 init 1024 2048 S 1200", rows), 123456, 1);
    expect(snapshot.processRows).toHaveLength(1_000);
    expect(snapshot.processRows?.[999]?.cpuPercent?.value).toBe(95.5);
    expect(snapshot.processRowsTruncated).toBe(true);
  });
});
