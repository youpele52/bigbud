import type { MonitorAppGroup, MonitorAppResources } from "@bigbud/contracts/system-monitor/types";
import { fields, requireKind } from "./wire.reader";
import { decodeMetric } from "./wire.metric";

function decodeGroup(bytes: Uint8Array): MonitorAppGroup {
  const value: MonitorAppGroup = { role: "desktop", processCount: 0 };
  const metrics = {
    3: "cpuPercent",
    4: "residentBytes",
    5: "readBytesPerSecond",
    6: "writtenBytesPerSecond",
  } as const;
  let hasRole = false;
  fields(bytes, (field, kind, reader) => {
    if (field === 1) {
      requireKind(kind, 2);
      const role = reader.string();
      if (role !== "desktop" && role !== "backend" && role !== "native" && role !== "tools")
        throw new Error("invalid app process role");
      value.role = role;
      hasRole = true;
    } else if (field === 2) {
      requireKind(kind, 0);
      value.processCount = reader.uint();
      if (value.processCount > 512) throw new Error("app process count exceeds limit");
    } else if (field >= 3 && field <= 6) {
      requireKind(kind, 2);
      Object.assign(value, {
        [metrics[field as keyof typeof metrics]]: decodeMetric(reader.data()),
      });
    } else reader.skip(kind);
  });
  if (!hasRole) throw new Error("missing app process role");
  return value;
}

export function decodeAppResources(bytes: Uint8Array): MonitorAppResources {
  const value: Partial<MonitorAppResources> = {
    generation: 0,
    sampledAtMs: 0,
    incomplete: false,
    groups: [],
  };
  fields(bytes, (field, kind, reader) => {
    if (field >= 1 && field <= 3) {
      requireKind(kind, 0);
      const number = reader.uint();
      if (field === 1) value.generation = number;
      else if (field === 2) value.sampledAtMs = number;
      else value.incomplete = number !== 0;
    } else if (field >= 4 && field <= 6) {
      requireKind(kind, 2);
      const group = decodeGroup(reader.data());
      if (field === 4) value.core = group;
      else if (field === 5) value.inclusive = group;
      else {
        value.groups!.push(group);
        if (value.groups!.length > 4) throw new Error("too many app resource groups");
      }
    } else reader.skip(kind);
  });
  if (
    !value.core ||
    !value.inclusive ||
    new Set(value.groups!.map((g) => g.role)).size !== value.groups!.length
  )
    throw new Error("invalid app resource summary");
  return value as MonitorAppResources;
}
