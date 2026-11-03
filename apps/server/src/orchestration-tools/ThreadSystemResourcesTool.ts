import type { MonitorMetric } from "@bigbud/contracts/system-monitor/types";
import { Data, Effect, Schema } from "effect";
import { ResourceRead, ResourceRuleMutation } from "@bigbud/contracts/system-monitor/awareness.ts";
import { requestDesktopResources } from "./ThreadSystemResourcesTool.client.ts";
export { setSystemMonitorAgentAccess } from "./ThreadSystemResourcesTool.client.ts";

const UNAVAILABLE = { available: false, reason: "desktop monitor unavailable" } as const;
class SystemResourcesError extends Data.TaggedError("SystemResourcesError")<{
  readonly message: string;
}> {}
const resourceError = (error: unknown) =>
  new SystemResourcesError({
    message: error instanceof Error ? error.message.slice(0, 256) : UNAVAILABLE.reason,
  });
const STATUSES = new Set(["ready", "warming", "unsupported", "denied", "unavailable", "stale"]);
type AgentMetric = {
  readonly value: number | null;
  readonly status: MonitorMetric["status"];
  readonly sampledAtMs: number;
};

export type SystemResourcesResult =
  | { readonly available: false; readonly reason: string }
  | {
      readonly [key: string]: unknown;
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
    status:
      item.status === "ready" &&
      (Date.now() - item.sampledAtMs > 5000 || item.sampledAtMs > Date.now() + 2000)
        ? "stale"
        : (item.status as MonitorMetric["status"]),
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
    Date.now() - result.sampledAtMs > 5_000 ||
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
  const extensions = Object.fromEntries(
    [
      "scope",
      "resourceSignals",
      "health",
      "monitoringEnabled",
      "ruleRevision",
      "alerts",
      "alertsTruncated",
      "collectionTruncated",
      "appResources",
      "baseline",
      "perCorePercent",
      "perCoreTruncated",
      "disks",
      "disksTruncated",
      "temperaturesCelsius",
      "criticalTemperaturesCelsius",
      "sensorsTruncated",
      "interfaces",
      "interfacesTruncated",
      "processes",
      "processStatus",
      "generation",
      "nextCursor",
      "truncatedInventory",
      "cursorNotice",
      "trends",
      "observedSamples",
      "selectedSamples",
      "sampling",
      "omissions",
    ]
      .filter((key) => key in result)
      .map((key) => [key, result[key]]),
  );
  return {
    ...extensions,
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

export const getSystemResources = Effect.fn("getSystemResources")(function* (
  input: unknown = {},
  cacheOnly = false,
) {
  return yield* Effect.tryPromise({
    try: async (): Promise<SystemResourcesResult> => {
      const decoded = Schema.decodeUnknownSync(ResourceRead)(input);
      const result = await requestDesktopResources(
        cacheOnly ? "/context" : "/read",
        cacheOnly ? undefined : decoded,
      );
      if (decoded.view === "rules" && result && typeof result === "object")
        return result as SystemResourcesResult;
      return parseSummary(result);
    },
    catch: resourceError,
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        available: false as const,
        reason: error instanceof Error ? error.message.slice(0, 256) : UNAVAILABLE.reason,
      }),
    ),
  );
});

export const configureSystemResourceRules = Effect.fn("configureSystemResourceRules")(function* (
  input: unknown,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const decoded = Schema.decodeUnknownSync(ResourceRuleMutation)(input);
      return (await requestDesktopResources("/rules", decoded)) as Record<string, unknown>;
    },
    catch: resourceError,
  });
});
