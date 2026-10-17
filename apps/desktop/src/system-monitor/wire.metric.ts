import type { MonitorMetric } from "@bigbud/contracts/system-monitor/types";
import { fields, requireKind } from "./wire.reader";

export function decodeMetric(bytes: Uint8Array): MonitorMetric {
  const metric: MonitorMetric = { value: 0, status: "unavailable", sampledAtMs: 0 };
  fields(bytes, (field, kind, reader) => {
    if (field === 1) {
      requireKind(kind, 1);
      metric.value = reader.double();
    } else if (field === 2) {
      requireKind(kind, 2);
      metric.status = reader.string() as MonitorMetric["status"];
    } else if (field === 3) {
      requireKind(kind, 0);
      metric.sampledAtMs = reader.uint();
    } else reader.skip(kind);
  });
  if (
    !Number.isFinite(metric.value) ||
    !["ready", "warming", "unsupported", "denied", "unavailable", "stale"].includes(metric.status)
  )
    throw new Error("invalid metric");
  return metric;
}
