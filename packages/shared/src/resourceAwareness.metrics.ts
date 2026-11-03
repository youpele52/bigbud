import type { ResourceRule } from "@bigbud/contracts/system-monitor/awareness.ts";
import type { MonitorMetric, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

export interface ResourceReading {
  entity: string;
  value: number;
  sampledAtMs: number;
  maxAgeMs: number;
  threshold: number;
  recovery: number;
  over: boolean;
  recovered: boolean;
}

/** Native status always wins over wall-clock freshness. Missing is never zero. */
export function freshResourceMetric(
  metric: MonitorMetric | undefined,
  now: number,
  maxAge = 5000,
): metric is MonitorMetric {
  return (
    metric?.status === "ready" &&
    Number.isFinite(metric.value) &&
    Number.isFinite(metric.sampledAtMs) &&
    now - metric.sampledAtMs <= maxAge &&
    metric.sampledAtMs <= now + 2000
  );
}

/** Freshness follows native source refresh cadence, not renderer delivery cadence. */
export function resourceMetricMaxAge(metric: ResourceRule["metric"]): number {
  return metric === "disk" ? 25000 : metric === "temperature" ? 35000 : 5000;
}

export function resourceReadings(
  snapshot: MonitorSnapshot,
  rule: ResourceRule,
  now: number,
): ResourceReading[] {
  const maxAge = resourceMetricMaxAge(rule.metric);
  const make = (
    entity: string,
    metric: MonitorMetric | undefined,
    maxAgeMs = maxAge,
    threshold = rule.threshold,
    recovery = rule.recovery,
  ): ResourceReading[] => {
    if (!freshResourceMetric(metric, now, maxAgeMs) || threshold === undefined) return [];
    const lower = recovery ?? threshold * 0.9;
    return [
      {
        entity,
        value: metric.value,
        sampledAtMs: metric.sampledAtMs,
        maxAgeMs,
        threshold,
        recovery: lower,
        over: metric.value >= threshold,
        recovered: metric.value < lower,
      },
    ];
  };
  const percentage = (
    used: MonitorMetric | undefined,
    total: MonitorMetric | undefined,
    maxAgeMs: number,
  ): MonitorMetric | undefined =>
    freshResourceMetric(used, now, maxAgeMs) &&
    freshResourceMetric(total, now, maxAgeMs) &&
    total.value > 0 &&
    used.value >= 0 &&
    used.value <= total.value
      ? {
          value: (used.value / total.value) * 100,
          sampledAtMs: Math.min(used.sampledAtMs, total.sampledAtMs),
          status: "ready",
        }
      : undefined;
  switch (rule.metric) {
    case "hostCpu":
      return make("host", snapshot.cpuPercent);
    case "hostMemory":
      return make("host", percentage(snapshot.memoryUsedBytes, snapshot.memoryTotalBytes, maxAge));
    case "appCpu":
    case "appMemory": {
      if (!snapshot.appResources || snapshot.appResources.incomplete || rule.scope === "host")
        return [];
      const group = snapshot.appResources[rule.scope];
      return make(rule.scope, rule.metric === "appCpu" ? group.cpuPercent : group.residentBytes);
    }
    case "disk":
      return snapshot.disks.slice(0, 64).flatMap((disk) => {
        if (rule.entity && disk.mount !== rule.entity) return [];
        if (
          !rule.entity &&
          (snapshot.disksTruncated ||
            disk.removable?.status !== "ready" ||
            now - disk.removable.sampledAtMs > maxAge ||
            disk.removable.sampledAtMs > now + 2000 ||
            disk.removable.value ||
            disk.readOnly?.status !== "ready" ||
            now - disk.readOnly.sampledAtMs > maxAge ||
            disk.readOnly.sampledAtMs > now + 2000 ||
            disk.readOnly.value)
        )
          return [];
        const values = make(disk.mount, percentage(disk.usedBytes, disk.totalBytes, maxAge));
        if (rule.minimumFreeBytes === undefined) return values;
        if (!freshResourceMetric(disk.freeBytes, now, maxAge) || disk.freeBytes.value < 0)
          return [];
        return values.map((value) =>
          Object.assign(value, {
            sampledAtMs: Math.min(value.sampledAtMs, disk.freeBytes!.sampledAtMs),
            over: value.over && disk.freeBytes!.value <= rule.minimumFreeBytes!,
            recovered:
              value.recovered ||
              disk.freeBytes!.value > (rule.recoveryFreeBytes ?? rule.minimumFreeBytes!),
          }),
        );
      });
    case "temperature":
      if (!rule.entity && snapshot.sensorsTruncated) return [];
      return snapshot.temperaturesCelsius.slice(0, 64).flatMap((sensor) => {
        if (rule.entity && sensor.name !== rule.entity) return [];
        const critical = snapshot.criticalTemperaturesCelsius?.find(
          (item) => item.name === sensor.name,
        )?.metric;
        const threshold =
          rule.threshold ??
          (freshResourceMetric(critical, now, maxAge) ? critical.value : undefined);
        return make(
          sensor.name,
          sensor.metric,
          maxAge,
          threshold,
          rule.recovery ?? (threshold === undefined ? undefined : threshold - 5),
        );
      });
  }
}
