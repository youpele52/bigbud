import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

const CPU_SECTION = /^###CPU###\r?\n([\s\S]*?)(?=^###[A-Z0-9]+###\r?$)/m;

/** The `/proc/stat` lines of one owner sample, or undefined when absent. */
export function cpuSection(sample: string): string | undefined {
  return CPU_SECTION.exec(sample)?.[1];
}

/**
 * The parser's two-sample CPU input from one owner sample: the previous
 * sample's counters as CPU1 and this sample's as CPU2. The owner recipe never
 * sleeps, so CPU usage is the delta between two successive samples.
 */
export function withCpuWindow(sample: string, previousCpu: string): string {
  return `###CPU1###\n${previousCpu}${sample.replace(/^###CPU###(\r?)$/m, "###CPU2###$1")}`;
}

/** Network rates from the previous snapshot of the same target; the first sample warms up. */
export function applyNetworkRates(
  snapshot: MonitorSnapshot,
  previous: MonitorSnapshot | undefined,
): void {
  const elapsed = previous ? (snapshot.sampledAtMs - previous.sampledAtMs) / 1_000 : 0;
  if (!previous && snapshot.interfaces.some((item) => item.name !== "lo")) {
    const warming = { value: 0, status: "warming" as const, sampledAtMs: snapshot.sampledAtMs };
    snapshot.networkReceivedBytesPerSecond = warming;
    snapshot.networkTransmittedBytesPerSecond = { ...warming };
  }
  if (!previous || elapsed <= 0) return;
  const oldInterfaces = new Map(previous.interfaces.map((item) => [item.name, item]));
  let received = 0;
  let transmitted = 0;
  let measured = false;
  snapshot.interfaces = snapshot.interfaces.map((item) => {
    const old = oldInterfaces.get(item.name);
    const rate = (current?: number, prior?: number) =>
      current !== undefined && prior !== undefined && current >= prior
        ? {
            value: (current - prior) / elapsed,
            status: "ready" as const,
            sampledAtMs: snapshot.sampledAtMs,
          }
        : undefined;
    const down = rate(item.receivedTotalBytes?.value, old?.receivedTotalBytes?.value);
    const up = rate(item.transmittedTotalBytes?.value, old?.transmittedTotalBytes?.value);
    if (item.name !== "lo") {
      measured ||= down !== undefined && up !== undefined;
      received += down?.value ?? 0;
      transmitted += up?.value ?? 0;
    }
    return {
      ...item,
      ...(down ? { receivedBytesPerSecond: down } : {}),
      ...(up ? { transmittedBytesPerSecond: up } : {}),
    };
  });
  if (measured) {
    snapshot.networkReceivedBytesPerSecond = {
      value: received,
      status: "ready",
      sampledAtMs: snapshot.sampledAtMs,
    };
    snapshot.networkTransmittedBytesPerSecond = {
      value: transmitted,
      status: "ready",
      sampledAtMs: snapshot.sampledAtMs,
    };
  }
}
