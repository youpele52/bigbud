import type { ResourceRead } from "@bigbud/contracts/system-monitor/awareness.ts";
import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import type { ResourceAwareness } from "./awareness";
import { resourceReadings } from "@bigbud/shared/resourceAwareness.metrics";
import { resourceTrends } from "./awareness.trends";

export function resourceSummary(snapshot: MonitorSnapshot): Record<string, unknown> {
  return {
    available: true,
    scope: "desktop-host",
    host: {
      hostname: snapshot.hostname,
      osName: snapshot.osName,
      osVersion: snapshot.osVersion,
      architecture: snapshot.architecture,
    },
    sampledAtMs: snapshot.sampledAtMs,
    ageMs: Math.max(0, Date.now() - snapshot.sampledAtMs),
    epoch: snapshot.epoch,
    sequence: snapshot.sequence,
    summaryStatus: snapshot.summaryStatus,
    baseline: snapshot.baseline,
    collectionTruncated: {
      disks: snapshot.disksTruncated,
      sensors: snapshot.sensorsTruncated,
      interfaces: snapshot.interfacesTruncated,
      perCore: snapshot.perCoreTruncated,
    },
    cpuPercent: snapshot.cpuPercent,
    memoryTotalBytes: snapshot.memoryTotalBytes,
    memoryUsedBytes: snapshot.memoryUsedBytes,
    memoryAvailableBytes: snapshot.memoryAvailableBytes,
    swapTotalBytes: snapshot.swapTotalBytes,
    swapUsedBytes: snapshot.swapUsedBytes,
    networkReceivedBytesPerSecond: snapshot.networkReceivedBytesPerSecond,
    networkTransmittedBytesPerSecond: snapshot.networkTransmittedBytesPerSecond,
    diskCapacityBytes: snapshot.diskCapacityBytes,
  };
}

/** Drops optional rows, preserving the latest trend preferentially, within the UTF-8 budget. */
export function boundedResourceResponse(input: Record<string, unknown>): string {
  // Responses can share persisted preferences and published telemetry with the owner.
  const result = structuredClone(input);
  const omissions: string[] = [];
  result.omissions = omissions;
  for (const key of [
    "perCorePercent",
    "interfaces",
    "processes",
    "trends",
    "disks",
    "temperaturesCelsius",
    "criticalTemperaturesCelsius",
    "alerts",
  ]) {
    const list = result[key];
    if (!Array.isArray(list)) continue;
    while (
      Buffer.byteLength(JSON.stringify(result)) > 32000 &&
      list.length > (key === "trends" ? 1 : 0)
    ) {
      if (key === "trends") list.shift();
      else list.pop();
      if (!omissions.includes(key)) omissions.push(key);
    }
  }
  if (omissions.includes("processes")) {
    result.nextCursor = null;
    result.truncatedInventory = true;
    result.cursorNotice =
      "Response rows were omitted to enforce the byte budget. Request a smaller limit; no cursor is supplied that could silently skip omitted rows.";
  }
  const preferences = result.preferences as { rules?: unknown[] } | undefined;
  while (preferences?.rules?.length && Buffer.byteLength(JSON.stringify(result)) > 32000) {
    preferences.rules.pop();
    result.rulesTruncated = true;
    if (!omissions.includes("preferences.rules")) omissions.push("preferences.rules");
  }
  if (Array.isArray(result.trends)) {
    if (Buffer.byteLength(JSON.stringify(result)) > 32000 && result.trends.length) {
      result.trends = [];
      if (!omissions.includes("trends")) omissions.push("trends");
    }
    const trends = result.trends as unknown[];
    result.selectedSamples = trends.length;
    if (!trends.length) result.sampling = "No samples returned; no interpolation.";
    else if (omissions.includes("trends"))
      result.sampling =
        "Observed samples retained within the byte budget, including the latest; no interpolation. Source status/timestamps and gaps remain meaningful.";
  }
  const body = JSON.stringify(result);
  if (Buffer.byteLength(body) > 32768)
    throw new Error("monitor response too large; request fewer categories");
  return body;
}

export async function readResourceView(
  owner: ResourceAwareness,
  input: ResourceRead,
  cacheOnly = false,
): Promise<Record<string, unknown>> {
  let state = owner.state();
  if (input.view === "rules") {
    const matching = state.preferences.rules.filter(
      (rule) => !input.search || rule.id.includes(input.search),
    );
    const rules = matching.slice(0, input.limit ?? 20);
    return {
      available: true,
      scope: "desktop-host",
      ...state,
      preferences: { ...state.preferences, rules },
      rulesTotal: matching.length,
      rulesTruncated: rules.length < matching.length,
      notice: "Use search to select a rule ID or limit up to 64 to read more rules.",
    };
  }
  const snapshot = await owner.readSnapshot(cacheOnly);
  state = owner.state();
  const result = {
    ...resourceSummary(snapshot),
    health: state.health,
    monitoringEnabled: state.preferences.enabled,
    ruleRevision: state.preferences.revision,
    alerts: state.alerts,
    alertsTruncated: state.alertsTruncated,
    appResources: snapshot.appResources ?? {
      status: state.appStatus === "unsupported" ? "unsupported" : "unavailable",
      reason: "App attribution requires a supported monitor and authoritative process roots.",
    },
    resourceSignals: state.preferences.rules
      .filter((rule) => rule.enabled && (rule.metric === "disk" || rule.metric === "temperature"))
      .flatMap((rule) =>
        resourceReadings(snapshot, rule, Date.now())
          .filter((reading) => reading.over)
          .map((reading) => ({ ruleId: rule.id, entity: reading.entity, warning: true })),
      )
      .slice(0, 16),
  };
  if (input.view === "processes") {
    const page = await owner.query({
      sort: input.sort ?? "cpu",
      descending: input.descending ?? true,
      limit: input.limit ?? 20,
      ...(input.search ? { search: input.search } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return {
      ...result,
      ...resourceSummary(owner.snapshot ?? snapshot),
      processes: page.rows,
      processStatus: owner.snapshot?.processStatus,
      generation: page.generation,
      nextCursor: page.nextDigest
        ? { generation: page.generation, digest: page.nextDigest, offset: page.nextOffset }
        : null,
      truncatedInventory: page.truncatedInventory,
      cursorNotice:
        "Inventory changes invalidate cursors; stale cursors are not restarted automatically.",
    };
  }
  if (input.view === "trends") {
    return { ...result, ...resourceTrends(owner.history, input, Date.now()) };
  }
  if (input.view !== "details") return result;
  const categories = new Set(
    input.categories ?? ["cpu", "memory", "disks", "sensors", "app", "network"],
  );
  return {
    ...result,
    ...(categories.has("cpu")
      ? {
          perCorePercent: snapshot.perCorePercent.slice(0, 128),
          perCoreTruncated: snapshot.perCoreTruncated || snapshot.perCorePercent.length > 128,
        }
      : {}),
    ...(categories.has("disks")
      ? {
          disks: snapshot.disks.slice(0, 32),
          disksTruncated: snapshot.disksTruncated || snapshot.disks.length > 32,
        }
      : {}),
    ...(categories.has("sensors")
      ? {
          temperaturesCelsius: snapshot.temperaturesCelsius.slice(0, 32),
          criticalTemperaturesCelsius: snapshot.criticalTemperaturesCelsius?.slice(0, 32),
          sensorsTruncated: snapshot.sensorsTruncated || snapshot.temperaturesCelsius.length > 32,
        }
      : {}),
    ...(categories.has("network")
      ? {
          interfaces: snapshot.interfaces.slice(0, 32),
          interfacesTruncated: snapshot.interfacesTruncated || snapshot.interfaces.length > 32,
        }
      : {}),
  };
}
