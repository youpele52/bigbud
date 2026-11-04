import type { MonitorMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

const LIMIT = 64;
const PROCESS_LIMIT = 1_000;

function number(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function counters(line: string | undefined): [number, number] | null {
  const fields = line?.trim().split(/\s+/) ?? [];
  const values = fields.slice(1).map(Number);
  if (
    !/^cpu(?:\d+)?$/.test(fields[0] ?? "") ||
    values.length < 5 ||
    values.some((v) => !Number.isFinite(v))
  )
    return null;
  return [values.reduce((a, b) => a + b, 0), values[3]! + values[4]!];
}

/** Reject incomplete or non-Linux reads rather than presenting partial data as live. */
export function parseSshMonitor(
  output: string,
  sampledAtMs: number,
  sequence: number,
): MonitorSnapshot {
  const sections = new Map<string, string>();
  const parts = output.split(/^###([A-Z0-9]+)###\r?$/m);
  for (let i = 1; i < parts.length - 1; i += 2) sections.set(parts[i]!, parts[i + 1]!.trim());
  if (!sections.has("END") || !sections.has("MEM") || !sections.has("CPU2"))
    throw new Error("Incomplete Linux monitor sample");
  const osName = sections.get("OS")?.trim() ?? "";
  if (osName !== "Linux") throw new Error(`Unsupported remote OS: ${osName || "unknown"}`);
  const metric = (value: number | undefined): MonitorMetric | undefined =>
    value !== undefined && Number.isFinite(value) && value >= 0
      ? { value, status: "ready", sampledAtMs }
      : undefined;
  const optionalMetric = (name: string, value: number | undefined) => {
    const result = metric(value);
    return result ? { [name]: result } : {};
  };
  const a = counters(sections.get("CPU1")?.split("\n")[0]);
  const b = counters(sections.get("CPU2")?.split("\n")[0]);
  const delta = a && b ? b[0] - a[0] : 0;
  const cpu =
    a && b && delta > 0
      ? Math.max(0, Math.min(100, (100 * (delta - (b[1] - a[1]))) / delta))
      : undefined;
  const firstCores = (sections.get("CPU1") ?? "")
    .split("\n")
    .filter((line) => /^cpu\d+\s/.test(line));
  const secondCores = (sections.get("CPU2") ?? "")
    .split("\n")
    .filter((line) => /^cpu\d+\s/.test(line));
  const perCorePercent = firstCores.flatMap((line, index) => {
    const before = counters(line);
    const after = counters(secondCores[index]);
    if (!before || !after || after[0] <= before[0]) return [];
    const value = Math.max(
      0,
      Math.min(
        100,
        (100 * (after[0] - before[0] - (after[1] - before[1]))) / (after[0] - before[0]),
      ),
    );
    return [{ name: line.trim().split(/\s+/)[0]!, metric: metric(value)! }];
  });
  const mem = new Map(
    (sections.get("MEM") ?? "").split("\n").map((line) => {
      const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line.trim());
      return match ? ([match[1]!, Number(match[2]) * 1024] as const) : (["", 0] as const);
    }),
  );
  const total = mem.get("MemTotal");
  const available = mem.get("MemAvailable");
  if (!total || available === undefined || !a || !b)
    throw new Error("Missing Linux CPU or memory counters");
  const diskLines = (sections.get("DF") ?? "").split("\n").slice(1);
  const allDisks = diskLines.flatMap((line) => {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim());
    if (!match) return [];
    return [
      {
        name: match[1]!,
        filesystem: match[1]!,
        mount: match[5]!,
        totalBytes: { value: Number(match[2]) * 1024, status: "ready" as const, sampledAtMs },
        usedBytes: { value: Number(match[3]) * 1024, status: "ready" as const, sampledAtMs },
        freeBytes: { value: Number(match[4]) * 1024, status: "ready" as const, sampledAtMs },
      },
    ];
  });
  const disks = allDisks.slice(0, LIMIT);
  const root = allDisks.find((disk) => disk.mount === "/");
  if (root && !disks.includes(root)) disks.splice(LIMIT - 1, 1, root);
  const networks = (sections.get("NET") ?? "")
    .split("\n")
    .slice(2)
    .flatMap((line) => {
      const match = /^\s*([^:]+):\s*(.+)$/.exec(line);
      if (!match) return [];
      const fields = match[2]!.trim().split(/\s+/);
      const received = number(fields[0]);
      const transmitted = number(fields[8]);
      return received === undefined || transmitted === undefined
        ? []
        : [{ name: match[1]!.trim(), received, transmitted }];
    });
  const interfaces = networks.slice(0, LIMIT).map(({ name, received, transmitted }) => ({
    name,
    receivedTotalBytes: { value: received, status: "ready" as const, sampledAtMs },
    transmittedTotalBytes: { value: transmitted, status: "ready" as const, sampledAtMs },
  }));
  const swapTotal = mem.get("SwapTotal");
  const swapFree = mem.get("SwapFree");
  const uptime = number(sections.get("UPTIME")?.split(/\s+/)[0]);
  const processLines = (sections.get("PROCESS") ?? "").split("\n").filter(Boolean);
  const processRows = processLines.slice(0, PROCESS_LIMIT).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const [pid, parentPid, name, resident, virtual, status, elapsed, cpuValue] = fields;
    const seconds = number(elapsed);
    const cpuPercent = number(cpuValue);
    if (
      number(pid) === undefined ||
      number(parentPid) === undefined ||
      !name ||
      number(resident) === undefined ||
      number(virtual) === undefined ||
      seconds === undefined
    )
      return [];
    return [
      {
        pid: Number(pid),
        parentPid: Number(parentPid),
        name,
        status: status ?? "unknown",
        startTimeSeconds: Math.max(0, sampledAtMs / 1000 - seconds),
        runTimeSeconds: seconds,
        residentBytes: (number(resident) ?? 0) * 1024,
        virtualBytes: (number(virtual) ?? 0) * 1024,
        ...(cpuPercent !== undefined ? { cpuPercent: metric(cpuPercent)! } : {}),
      },
    ];
  });
  const partial = !root || interfaces.length === 0 || processRows.length === 0;
  const unavailable: MonitorMetric = { value: 0, status: "unavailable", sampledAtMs };
  return {
    subscriptionId: 0,
    epoch: 0,
    sequence,
    baseline: sequence === 1,
    sampledAtMs,
    hostname: sections.get("HOST")?.trim() ?? "Remote host",
    osName,
    osVersion: "",
    architecture: sections.get("ARCH")?.trim() ?? "",
    ...(sections.get("KERNEL") ? { kernelVersion: sections.get("KERNEL")!.trim() } : {}),
    ...optionalMetric("cpuPercent", cpu),
    perCorePercent,
    ...optionalMetric("logicalCores", sections.get("CPU1")?.match(/^cpu\d+ /gm)?.length),
    memoryTotalBytes: metric(total)!,
    memoryAvailableBytes: metric(available)!,
    memoryUsedBytes: metric(Math.max(0, total - available))!,
    ...optionalMetric("swapTotalBytes", swapTotal),
    ...optionalMetric("swapFreeBytes", swapFree),
    ...optionalMetric(
      "swapUsedBytes",
      swapTotal !== undefined && swapFree !== undefined
        ? Math.max(0, swapTotal - swapFree)
        : undefined,
    ),
    ...optionalMetric("uptimeSeconds", uptime),
    diskCapacityBytes: metric(root?.totalBytes?.value) ?? unavailable,
    networkReceivedBytesPerSecond: unavailable,
    networkTransmittedBytesPerSecond: unavailable,
    disks,
    interfaces,
    processRows,
    processRowsTruncated: processLines.length > PROCESS_LIMIT,
    temperaturesCelsius: (sections.get("TEMP") ?? "")
      .split("\n")
      .slice(0, LIMIT)
      .flatMap((line) => {
        const match = /^(\S+)\s+(-?\d+)$/.exec(line);
        const value = match ? Number(match[2]) / 1000 : NaN;
        return match && Number.isFinite(value) && value > -100 && value < 200
          ? [{ name: match[1]!, metric: { value, status: "ready" as const, sampledAtMs } }]
          : [];
      }),
    processStatus: processRows.length ? "ready" : "unavailable",
    summaryStatus: partial ? "partial" : "ready",
    perCoreTruncated: firstCores.length >= 64,
    disksTruncated: allDisks.length > LIMIT,
    interfacesTruncated: networks.length > LIMIT,
    sensorsTruncated: false,
  };
}
