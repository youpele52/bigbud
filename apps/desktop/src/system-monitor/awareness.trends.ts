import type { ResourceRead } from "@bigbud/contracts/system-monitor/awareness.ts";
import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

/** Picks timestamped observations evenly, including the latest, within a reserved wire budget. */
export function resourceTrends(history: MonitorSnapshot[], input: ResourceRead, now: number) {
  const categories = new Set(input.categories ?? ["cpu", "memory", "app"]);
  const samples = history.filter(
    (sample) => sample.sampledAtMs >= now - (input.windowSeconds ?? 60) * 1000,
  );
  const points = samples.map((sample) => ({
    sampledAtMs: sample.sampledAtMs,
    epoch: sample.epoch,
    baseline: sample.baseline,
    ...(categories.has("cpu") ? { cpuPercent: sample.cpuPercent } : {}),
    ...(categories.has("memory")
      ? {
          memoryUsedBytes: sample.memoryUsedBytes,
          memoryAvailableBytes: sample.memoryAvailableBytes,
        }
      : {}),
    ...(categories.has("app") && sample.appResources
      ? {
          appResources: {
            incomplete: sample.appResources.incomplete,
            core: {
              cpuPercent: sample.appResources.core.cpuPercent,
              residentBytes: sample.appResources.core.residentBytes,
            },
            inclusive: {
              cpuPercent: sample.appResources.inclusive.cpuPercent,
              residentBytes: sample.appResources.inclusive.residentBytes,
            },
          },
        }
      : {}),
    ...(categories.has("disks")
      ? {
          disks: sample.disks.slice(0, 3).map((disk) => ({
            mount: disk.mount,
            freeBytes: disk.freeBytes,
            usedBytes: disk.usedBytes,
          })),
          disksTruncated: sample.disksTruncated || sample.disks.length > 3,
        }
      : {}),
    ...(categories.has("sensors")
      ? {
          temperaturesCelsius: sample.temperaturesCelsius.slice(0, 3),
          sensorsTruncated: sample.sensorsTruncated || sample.temperaturesCelsius.length > 3,
        }
      : {}),
  }));
  const largest = Math.max(
    1,
    ...points.map((point) => Buffer.byteLength(JSON.stringify(point)) + 1),
  );
  const count = Math.min(60, points.length, Math.max(1, Math.floor(20000 / largest)));
  const trends = Array.from(
    { length: count },
    (_, index) =>
      points[
        count === 1 ? points.length - 1 : Math.round((index * (points.length - 1)) / (count - 1))
      ]!,
  );
  return {
    trends,
    observedSamples: samples.length,
    selectedSamples: trends.length,
    sampling: trends.length
      ? "Evenly selected observed samples including the latest; no interpolation. Source status/timestamps and gaps remain meaningful. Request categories disks or sensors for those histories (up to 3 entities per point)."
      : "No samples returned; no interpolation.",
  };
}
