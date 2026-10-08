import type {
  MonitorAppResources,
  MonitorMetric,
  MonitorSnapshot,
} from "@bigbud/contracts/system-monitor/types";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BigbudResourceView } from "./BigbudResourceView";
import { appCard, appMetricValue, currentAppResources } from "./BigbudResourceView.logic";
import { useResourceMonitor } from "./useResourceMonitor";

vi.mock("./useResourceMonitor", () => ({ useResourceMonitor: vi.fn() }));
const metric = (value: number): MonitorMetric => ({ value, status: "ready", sampledAtMs: 1000 });
const app: MonitorAppResources = {
  generation: 1,
  sampledAtMs: 1000,
  incomplete: false,
  core: {
    role: "desktop",
    processCount: 12,
    cpuPercent: metric(4.8),
    residentBytes: metric(1024 ** 3),
    readBytesPerSecond: metric(0),
    writtenBytesPerSecond: metric(2048),
  },
  inclusive: {
    role: "tools",
    processCount: 20,
    cpuPercent: metric(18.4),
    residentBytes: metric(2 * 1024 ** 3),
  },
  groups: [
    { role: "backend", processCount: 1, cpuPercent: metric(1.4), residentBytes: metric(1024) },
  ],
};
const snapshot = {
  appResources: app,
  sampledAtMs: 1000,
  summaryStatus: "ready",
  osName: "Darwin",
  memoryTotalBytes: metric(16 * 1024 ** 3),
} as MonitorSnapshot;

beforeEach(() =>
  vi.mocked(useResourceMonitor).mockReturnValue({
    snapshot,
    appReason: null,
    appHistory: { cpu: [], memory: [] },
    history: { cpu: [], memory: [], network: [] },
    connection: "connected",
    reason: null,
    collectionStatus: null,
  }),
);

describe("BigbudResourceView", () => {
  it("separates core from inclusive totals and demands app resources, not the process table", () => {
    const markup = renderToStaticMarkup(<BigbudResourceView visible />);
    expect(useResourceMonitor).toHaveBeenLastCalledWith(true, false, false, true);
    expect(markup).toContain("Core bigbud");
    expect(markup).toContain("Including agents/tools");
    expect(markup).toContain("4.80%");
    expect(markup).toContain("18.40%");
    expect(markup).toContain("Backend");
    expect(markup).toContain("Read 0.00 B/s");
    expect(markup).toContain("estimated");
    expect(markup).toContain("CPU capacity: 4.80% core bigbud of total host CPU");
    expect(markup).toContain("Memory capacity: 6.25% core bigbud of total host RAM");
    expect(markup).not.toContain(">of host CPU<");
    expect(markup).not.toContain(">of host RAM<");
    expect(markup).not.toContain(">Remaining capacity<");
    expect(markup).not.toContain("Usage over time");
  });
  it("does not display old totals when transport is unavailable", () => {
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false, true),
      connection: "unavailable",
      reason: "child exited",
    });
    const markup = renderToStaticMarkup(<BigbudResourceView visible={false} />);
    expect(useResourceMonitor).toHaveBeenLastCalledWith(false, false, false, true);
    expect(markup).toContain("child exited");
    expect(markup).not.toContain("18.40%");
  });
  it("labels the broader Windows counters as process I/O", () => {
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false, true),
      snapshot: { ...snapshot, osName: "Windows" },
    });
    expect(renderToStaticMarkup(<BigbudResourceView visible />)).toContain("Process I/O");
  });
  it("shows an actionable missing-sample diagnostic instead of indefinite warming", () => {
    const missing = { ...snapshot };
    delete missing.appResources;
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false, true),
      snapshot: missing,
      appReason: "No bigbud samples received. Restart the desktop app.",
    });
    const markup = renderToStaticMarkup(<BigbudResourceView visible />);
    expect(markup).toContain("Restart the desktop app");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("Waiting for a fresh bigbud sample");
    expect(markup).not.toContain(">warming<");
  });
  it("rejects stale samples, missing values and non-finite ready values", () => {
    expect(currentAppResources({ ...snapshot, sampledAtMs: 12000 }, true)).toBeUndefined();
    expect(currentAppResources(snapshot, false)).toBeUndefined();
    expect(appMetricValue(undefined, String)).toBe("—");
    expect(appMetricValue({ ...metric(0), status: "unsupported" }, String)).toBe("—");
    expect(appMetricValue(metric(Number.NaN), String)).toBe("—");
  });
  it("requires measured app usage and valid physical RAM for capacity shares", () => {
    expect(appCard(app.core, "cpu").capacity).toEqual({ used: 4.8, total: 100 });
    expect(appCard(app.core, "memory").capacity).toBeUndefined();
    expect(appCard(app.core, "memory", metric(0)).capacity).toBeUndefined();
    expect(
      appCard(app.core, "memory", { ...metric(1024), status: "stale" }).capacity,
    ).toBeUndefined();
    expect(
      appCard({ ...app.core, cpuPercent: { ...metric(0), status: "warming" } }, "cpu").capacity,
    ).toBeUndefined();
    expect(appCard({ ...app.core, cpuPercent: metric(101) }, "cpu").capacity).toBeUndefined();
    expect(appCard({ ...app.core, cpuPercent: metric(0) }, "cpu").capacity).toEqual({
      used: 0,
      total: 100,
    });
  });
  it("leaves the memory share unavailable without host RAM, while keeping measured bytes", () => {
    const missingTotal = { ...snapshot };
    delete missingTotal.memoryTotalBytes;
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false, true),
      snapshot: missingTotal,
    });
    const markup = renderToStaticMarkup(<BigbudResourceView visible />);
    expect(markup).toContain("Memory capacity: unavailable");
    expect(markup).toContain("1.00 GiB");
    expect(markup).toContain("estimated");
    expect(markup).not.toContain("Memory capacity: 0.00%");
  });
  it("does not chart incomplete ownership totals", () => {
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false, true),
      snapshot: { ...snapshot, appResources: { ...app, incomplete: true } },
    });
    const markup = renderToStaticMarkup(<BigbudResourceView visible />);
    expect(markup).toContain("CPU capacity: unavailable");
    expect(markup).toContain("Memory capacity: unavailable");
  });
  it("warns rather than concealing resident-memory estimates larger than physical RAM", () => {
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false, true),
      snapshot: { ...snapshot, memoryTotalBytes: metric(0.5 * 1024 ** 3) },
    });
    const markup = renderToStaticMarkup(<BigbudResourceView visible />);
    expect(markup).toContain("Memory capacity: 200.00% core bigbud");
    expect(markup).toContain("Estimate exceeds host RAM");
  });
});
