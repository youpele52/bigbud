import type { MonitorMetric } from "@bigbud/contracts/system-monitor/types";
import { Effect } from "effect";

const UNAVAILABLE = { available: false, reason: "desktop monitor unavailable" } as const;
const MAX_BYTES = 32 * 1024;
const STATUSES = new Set(["ready", "warming", "unsupported", "denied", "unavailable", "stale"]);
type AgentMetric = {
  readonly value: number | null;
  readonly status: MonitorMetric["status"];
  readonly sampledAtMs: number;
};

export type SystemResourcesResult =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly host: {
        readonly hostname: string;
        readonly osName: string;
        readonly osVersion: string;
        readonly architecture: string;
      };
      readonly sampledAtMs: number;
      readonly ageMs: number;
      readonly epoch: number;
      readonly sequence: number;
      readonly summaryStatus: string;
      readonly cpuPercent: AgentMetric;
      readonly memoryTotalBytes: AgentMetric;
      readonly memoryUsedBytes: AgentMetric;
      readonly memoryAvailableBytes: AgentMetric;
      readonly swapTotalBytes: AgentMetric;
      readonly swapUsedBytes: AgentMetric;
      readonly networkReceivedBytesPerSecond: AgentMetric;
      readonly networkTransmittedBytesPerSecond: AgentMetric;
      readonly diskCapacityBytes: AgentMetric;
    };

let access: { readonly endpoint: string; readonly token: string } | undefined;
export function setSystemMonitorAgentAccess(next: typeof access): void {
  access = next;
}

const parseEndpoint = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/snapshot" &&
      !url.username &&
      !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const metric = (value: unknown, sampledAtMs: number): AgentMetric => {
  const unavailable: AgentMetric = { value: null, status: "unavailable", sampledAtMs };
  if (!value || typeof value !== "object") return unavailable;
  const item = value as Record<string, unknown>;
  if (
    typeof item.value !== "number" ||
    !Number.isFinite(item.value) ||
    typeof item.status !== "string" ||
    !STATUSES.has(item.status) ||
    typeof item.sampledAtMs !== "number" ||
    !Number.isFinite(item.sampledAtMs)
  )
    return unavailable;
  return {
    value: item.value,
    status: item.status as MonitorMetric["status"],
    sampledAtMs: item.sampledAtMs,
  };
};

function parseSummary(parsed: unknown): SystemResourcesResult {
  if (!parsed || typeof parsed !== "object") return UNAVAILABLE;
  const result = parsed as Record<string, unknown>;
  const host = result.host as Record<string, unknown> | undefined;
  if (
    result.available !== true ||
    !host ||
    typeof host !== "object" ||
    typeof host.hostname !== "string" ||
    typeof host.osName !== "string" ||
    typeof host.osVersion !== "string" ||
    typeof host.architecture !== "string" ||
    typeof result.sampledAtMs !== "number" ||
    !Number.isFinite(result.sampledAtMs) ||
    Date.now() - result.sampledAtMs > 10_000 ||
    result.sampledAtMs > Date.now() + 2_000 ||
    typeof result.epoch !== "number" ||
    typeof result.sequence !== "number" ||
    typeof result.summaryStatus !== "string"
  )
    return UNAVAILABLE;
  const fields = [
    "cpuPercent",
    "memoryTotalBytes",
    "memoryUsedBytes",
    "memoryAvailableBytes",
    "swapTotalBytes",
    "swapUsedBytes",
    "networkReceivedBytesPerSecond",
    "networkTransmittedBytesPerSecond",
    "diskCapacityBytes",
  ] as const;
  const metrics = Object.fromEntries(
    fields.map((key) => [key, metric(result[key], result.sampledAtMs as number)]),
  ) as Record<(typeof fields)[number], AgentMetric>;
  return {
    available: true,
    host: {
      hostname: host.hostname,
      osName: host.osName,
      osVersion: host.osVersion,
      architecture: host.architecture,
    },
    sampledAtMs: result.sampledAtMs,
    ageMs: Math.max(0, Date.now() - result.sampledAtMs),
    epoch: result.epoch,
    sequence: result.sequence,
    summaryStatus: result.summaryStatus,
    ...metrics,
  };
}

export const getSystemResources = Effect.fn("getSystemResources")(function* () {
  const endpoint = access?.endpoint;
  const token = access?.token;
  if (!endpoint || !token) return UNAVAILABLE;
  const url = parseEndpoint(endpoint);
  if (!url) return UNAVAILABLE;
  return yield* Effect.tryPromise({
    try: async (): Promise<SystemResourcesResult> => {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(7_000),
      });
      if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES || !response.body)
        return UNAVAILABLE;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) {
          await response.body.cancel().catch(() => undefined);
          return UNAVAILABLE;
        }
        chunks.push(chunk);
      }
      if (!response.ok) return UNAVAILABLE;
      return parseSummary(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    },
    catch: () => "desktop monitor unavailable" as const,
  }).pipe(Effect.catch(() => Effect.succeed(UNAVAILABLE)));
});
