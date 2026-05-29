import type { App } from "electron";

interface ProcessMetricLike {
  readonly memory?: {
    readonly privateBytes?: number;
    readonly workingSetSize?: number;
  };
  readonly type?: string;
}

function formatMegabytes(value: number): string {
  return `${Math.round(value / (1024 * 1024))}MB`;
}

function summarizeProcessTypes(metrics: ReadonlyArray<ProcessMetricLike>): string {
  const counts = new Map<string, number>();

  for (const metric of metrics) {
    const type = metric.type ?? "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  return [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}:${count}`)
    .join(",");
}

export function formatDesktopPerformanceSnapshot(
  metrics: ReadonlyArray<ProcessMetricLike>,
): string {
  const totals = metrics.reduce(
    (accumulator, metric) => ({
      privateBytes: accumulator.privateBytes + (metric.memory?.privateBytes ?? 0),
      workingSetSize: accumulator.workingSetSize + (metric.memory?.workingSetSize ?? 0),
    }),
    { privateBytes: 0, workingSetSize: 0 },
  );

  return [
    `processes=${metrics.length}`,
    `rss=${formatMegabytes(totals.workingSetSize)}`,
    `private=${formatMegabytes(totals.privateBytes)}`,
    `types=${summarizeProcessTypes(metrics)}`,
  ].join(" ");
}

export function scheduleDesktopPerformanceSnapshots(
  appInstance: Pick<App, "getAppMetrics">,
  log: (message: string) => void,
): void {
  const snapshotDelaysMs = [5_000, 30_000];

  for (const delayMs of snapshotDelaysMs) {
    const timer = setTimeout(() => {
      log(
        `performance snapshot label=${delayMs / 1000}s ${formatDesktopPerformanceSnapshot(appInstance.getAppMetrics())}`,
      );
    }, delayMs);
    timer.unref();
  }
}

export function logDesktopGpuFeatureStatus(
  appInstance: Pick<App, "getGPUFeatureStatus">,
  log: (message: string) => void,
): void {
  const gpuStatus = appInstance.getGPUFeatureStatus();
  log(`gpu feature status ${JSON.stringify(gpuStatus)}`);
}
