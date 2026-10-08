import * as FS from "node:fs";
import * as Path from "node:path";
import type { MonitorEvent, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { expect, it, vi } from "vitest";
import { SystemMonitorBridge } from "./bridge";

vi.mock("../env/pathResolver", () => ({ resolvePackagedDesktopSupervisorBinary: () => null }));
const binary = Path.resolve(process.cwd(), "../../target/debug/bigbud-desktop-supervisor");

it.skipIf(!FS.existsSync(binary))(
  "streams core and inclusive accounting through the actual Rust codec and bridge",
  async () => {
    const previous = process.env.BIGBUD_SYSTEM_MONITOR_BINARY;
    process.env.BIGBUD_SYSTEM_MONITOR_BINARY = binary;
    const monitor = new SystemMonitorBridge(false, (child) => [
      { pid: process.pid, identity: "test-owner", role: "desktop" },
      ...(child?.pid
        ? [{ pid: child.pid, identity: "test-monitor", role: "native" as const }]
        : []),
    ]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const sample = new Promise<MonitorSnapshot>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("app resource sample timeout")), 10_000);
      monitor.addRenderer({
        isDestroyed: () => false,
        once: () => undefined,
        send: (_channel: string, event: MonitorEvent) => {
          if (event.type !== "snapshot") return;
          try {
            const snapshot = event.snapshot;
            monitor.ack(snapshot.subscriptionId, snapshot.epoch, snapshot.sequence);
            if (snapshot.appResources?.core.cpuPercent?.status === "ready") resolve(snapshot);
          } catch (error) {
            reject(error);
          }
        },
      } as never);
    });
    try {
      const id = await monitor.subscribe({
        processes: false,
        disks: false,
        sensors: false,
        appResources: true,
      });
      const snapshot = await sample;
      expect(snapshot.appResources).toMatchObject({
        incomplete: false,
        core: {
          processCount: 2,
          cpuPercent: { status: "ready" },
          residentBytes: { status: "ready" },
        },
      });
      expect(snapshot.appResources!.inclusive.processCount).toBeGreaterThanOrEqual(2);
      expect(snapshot.appResources!.groups.map((group) => group.role)).toEqual([
        "desktop",
        "backend",
        "native",
        "tools",
      ]);
      monitor.unsubscribe(id);
    } finally {
      if (timeout) clearTimeout(timeout);
      monitor.stop();
      if (previous === undefined) delete process.env.BIGBUD_SYSTEM_MONITOR_BINARY;
      else process.env.BIGBUD_SYSTEM_MONITOR_BINARY = previous;
    }
  },
  15_000,
);
