import type {
  MonitorDisk,
  MonitorFlag,
  MonitorTextField,
  MonitorNetworkInterface,
  MonitorEvent,
  MonitorMetric,
  MonitorNamedMetric,
  MonitorProcessPage,
  MonitorProcessRow,
  MonitorSnapshot,
} from "@bigbud/contracts/system-monitor/types";
import { MAX_FRAME_BYTES } from "./wire.constants";
import { fields, requireKind } from "./wire.reader";
import { decodeHelloAck } from "./wire.hello";
import { decodeCollectionStatus } from "./wire.status";
import { decodeMetric } from "./wire.metric";
import { decodeAppResources } from "./wire.app";
function decodeFlag(bytes: Uint8Array): MonitorFlag {
  const flag: MonitorFlag = { value: false, status: "unavailable", sampledAtMs: 0 };
  fields(bytes, (field, kind, reader) => {
    if (field === 1 || field === 3) {
      requireKind(kind, 0);
      if (field === 1) flag.value = reader.uint() !== 0;
      else flag.sampledAtMs = reader.uint();
    } else if (field === 2) {
      requireKind(kind, 2);
      flag.status = reader.string() as MonitorFlag["status"];
    } else reader.skip(kind);
  });
  if (!["ready", "warming", "unsupported", "denied", "unavailable", "stale"].includes(flag.status))
    throw new Error("invalid flag status");
  return flag;
}
function decodeTextField(bytes: Uint8Array): MonitorTextField {
  const value: MonitorTextField = { value: "", status: "unavailable", sampledAtMs: 0 };
  fields(bytes, (field, kind, reader) => {
    if (field === 1 || field === 2) {
      requireKind(kind, 2);
      if (field === 1) value.value = reader.string();
      else value.status = reader.string() as MonitorTextField["status"];
    } else if (field === 3) {
      requireKind(kind, 0);
      value.sampledAtMs = reader.uint();
    } else reader.skip(kind);
  });
  if (!["ready", "warming", "unsupported", "denied", "unavailable", "stale"].includes(value.status))
    throw new Error("invalid text field status");
  return value;
}
function decodeNamed(bytes: Uint8Array): MonitorNamedMetric {
  let name = "",
    metric: MonitorMetric = { value: 0, status: "unavailable", sampledAtMs: 0 };
  fields(bytes, (field, kind, reader) => {
    if (field === 1) {
      requireKind(kind, 2);
      name = reader.string();
    } else if (field === 2) {
      requireKind(kind, 2);
      metric = decodeMetric(reader.data());
    } else reader.skip(kind);
  });
  return { name, metric };
}
function decodeDisk(bytes: Uint8Array): MonitorDisk {
  const disk: MonitorDisk = { name: "", mount: "", filesystem: "" };
  const keys = [
    "",
    "",
    "",
    "",
    "totalBytes",
    "freeBytes",
    "usedBytes",
    "readBytesPerSecond",
    "writtenBytesPerSecond",
  ] as const;
  fields(bytes, (field, kind, reader) => {
    if (field >= 1 && field <= 3) {
      requireKind(kind, 2);
      if (field === 1) disk.name = reader.string();
      else if (field === 2) disk.mount = reader.string();
      else disk.filesystem = reader.string();
    } else if (field >= 4 && field <= 8) {
      requireKind(kind, 2);
      Object.assign(disk, { [keys[field]!]: decodeMetric(reader.data()) });
    } else if (field === 9 || field === 10) {
      requireKind(kind, 2);
      if (field === 9) disk.removable = decodeFlag(reader.data());
      else disk.readOnly = decodeFlag(reader.data());
    } else reader.skip(kind);
  });
  return disk;
}
function decodeInterface(bytes: Uint8Array): MonitorNetworkInterface {
  const row: MonitorNetworkInterface = { name: "" };
  const keys = [
    "",
    "",
    "receivedTotalBytes",
    "transmittedTotalBytes",
    "receivedBytesPerSecond",
    "transmittedBytesPerSecond",
    "receiveErrors",
    "transmitErrors",
    "receivedPackets",
    "transmittedPackets",
  ] as const;
  fields(bytes, (field, kind, reader) => {
    if (field === 1) {
      requireKind(kind, 2);
      row.name = reader.string();
    } else if (field >= 2 && field <= 9) {
      requireKind(kind, 2);
      Object.assign(row, { [keys[field]!]: decodeMetric(reader.data()) });
    } else if (field === 10 || field === 11) {
      requireKind(kind, 2);
      if (field === 10) row.linkState = decodeTextField(reader.data());
      else row.mtuBytes = decodeMetric(reader.data());
    } else reader.skip(kind);
  });
  return row;
}
function decodeSnapshot(bytes: Uint8Array): MonitorSnapshot {
  const criticalTemperaturesCelsius: MonitorNamedMetric[] = [];
  const value: MonitorSnapshot = {
    subscriptionId: 0,
    epoch: 0,
    sequence: 0,
    baseline: false,
    sampledAtMs: 0,
    hostname: "",
    perCorePercent: [],
    temperaturesCelsius: [],
    criticalTemperaturesCelsius,
    processStatus: "unavailable",
    summaryStatus: "unavailable",
    perCoreTruncated: false,
    disksTruncated: false,
    interfacesTruncated: false,
    sensorsTruncated: false,
    disks: [],
    interfaces: [],
    osName: "",
    osVersion: "",
    architecture: "",
    kernelVersion: "",
    cpuBrand: "",
  };
  const metricFields: Record<number, keyof MonitorSnapshot> = {
    7: "cpuPercent",
    9: "memoryTotalBytes",
    10: "memoryUsedBytes",
    11: "swapTotalBytes",
    12: "swapUsedBytes",
    13: "networkReceivedBytesPerSecond",
    14: "networkTransmittedBytesPerSecond",
    15: "diskCapacityBytes",
    24: "uptimeSeconds",
    25: "logicalCores",
    30: "memoryAvailableBytes",
    31: "swapFreeBytes",
    33: "bootTimeSeconds",
    34: "physicalCores",
    36: "cpuFrequencyMhz",
    37: "loadAverageOne",
    38: "loadAverageFive",
    39: "loadAverageFifteen",
  };
  fields(bytes, (field, kind, reader) => {
    if (field === 41) {
      requireKind(kind, 2);
      value.appResources = decodeAppResources(reader.data());
    } else if ([26, 27, 28, 29].includes(field)) {
      requireKind(kind, 0);
      const truncated = reader.uint() !== 0;
      if (field === 26) value.perCoreTruncated = truncated;
      else if (field === 27) value.disksTruncated = truncated;
      else if (field === 28) value.interfacesTruncated = truncated;
      else value.sensorsTruncated = truncated;
    } else if ([1, 2, 3, 4, 5].includes(field)) {
      requireKind(kind, 0);
      const n = reader.uint();
      if (field === 1) value.subscriptionId = n;
      else if (field === 2) value.epoch = n;
      else if (field === 3) value.sequence = n;
      else if (field === 4) value.baseline = !!n;
      else value.sampledAtMs = n;
    } else if (field === 19 || field === 20) {
      requireKind(kind, 2);
      if (field === 19) value.disks.push(decodeDisk(reader.data()));
      else value.interfaces.push(decodeInterface(reader.data()));
    } else if ([6, 17, 18, 21, 22, 23, 32, 35].includes(field)) {
      requireKind(kind, 2);
      if (field === 6) value.hostname = reader.string();
      else if (field === 17) value.processStatus = reader.string();
      else if (field === 18) value.summaryStatus = reader.string();
      else if (field === 21) value.osName = reader.string();
      else if (field === 22) value.osVersion = reader.string();
      else if (field === 23) value.architecture = reader.string();
      else if (field === 32) value.kernelVersion = reader.string();
      else value.cpuBrand = reader.string();
    } else if (field === 8 || field === 16 || field === 40) {
      requireKind(kind, 2);
      (field === 8
        ? value.perCorePercent
        : field === 16
          ? value.temperaturesCelsius
          : criticalTemperaturesCelsius
      ).push(decodeNamed(reader.data()));
    } else if (metricFields[field]) {
      requireKind(kind, 2);
      Object.assign(value, { [metricFields[field]]: decodeMetric(reader.data()) });
    } else reader.skip(kind);
  });
  if (value.subscriptionId < 1 || value.epoch < 1 || value.sequence < 1)
    throw new Error("invalid monitor snapshot identity");
  if (
    value.perCorePercent.length > 128 ||
    value.temperaturesCelsius.length > 16 ||
    criticalTemperaturesCelsius.length > 16 ||
    value.disks.length > 16 ||
    value.interfaces.length > 16
  )
    throw new Error("monitor snapshot exceeds collection limits");
  return value;
}
function decodeRow(bytes: Uint8Array): MonitorProcessRow {
  const row: MonitorProcessRow = {
    pid: 0,
    name: "",
    status: "",
    startTimeSeconds: 0,
    runTimeSeconds: 0,
    residentBytes: 0,
    virtualBytes: 0,
    diskReadBytes: 0,
    diskWrittenBytes: 0,
  };
  const nums: Record<number, keyof MonitorProcessRow> = {
    1: "pid",
    2: "parentPid",
    5: "startTimeSeconds",
    6: "runTimeSeconds",
    8: "residentBytes",
    9: "virtualBytes",
    10: "diskReadBytes",
    11: "diskWrittenBytes",
  };
  fields(bytes, (field, kind, reader) => {
    if (nums[field]) {
      requireKind(kind, 0);
      Object.assign(row, { [nums[field]]: reader.uint() });
    } else if (field === 3 || field === 4) {
      requireKind(kind, 2);
      if (field === 3) row.name = reader.string();
      else row.status = reader.string();
    } else if (field === 7) {
      requireKind(kind, 2);
      row.cpuPercent = decodeMetric(reader.data());
    } else reader.skip(kind);
  });
  return row;
}
function decodePage(bytes: Uint8Array): MonitorProcessPage {
  const page: MonitorProcessPage = {
    requestId: 0,
    rows: [],
    truncatedInventory: false,
    generation: 0,
    nextDigest: "0",
    nextOffset: 0,
  };
  fields(bytes, (field, kind, reader) => {
    if (field === 2) {
      requireKind(kind, 2);
      page.rows.push(decodeRow(reader.data()));
    } else if ([1, 3, 4, 5, 6].includes(field)) {
      requireKind(kind, 0);
      if (field === 5) {
        page.nextDigest = reader.uint64().toString();
        return;
      }
      const n = reader.uint();
      if (field === 1) page.requestId = n;
      else if (field === 3) page.truncatedInventory = !!n;
      else if (field === 4) page.generation = n;
      else page.nextOffset = n;
    } else reader.skip(kind);
  });
  if (page.requestId < 1 || page.rows.length > 100) throw new Error("invalid process page");
  return page;
}
export function decodeEvent(bytes: Uint8Array): MonitorEvent {
  if (!bytes.length || bytes.length > MAX_FRAME_BYTES)
    throw new Error("invalid monitor frame size");
  let result: MonitorEvent | undefined;
  fields(bytes, (field, kind, reader) => {
    if (![2, 6, 9, 11, 13, 14, 15].includes(field)) {
      reader.skip(kind);
      return;
    }
    requireKind(kind, 2);
    if (result) throw new Error("multiple monitor payloads");
    const payload = reader.data();
    if (field === 15)
      result = { type: "collectionStatus", status: decodeCollectionStatus(payload) };
    else if (field === 14) {
      let requestId = 0,
        epoch = 0;
      fields(payload, (f, k, r) => {
        if (f === 1 || f === 2) {
          requireKind(k, 0);
          if (f === 1) requestId = r.uint();
          else epoch = r.uint();
        } else r.skip(k);
      });
      if (requestId < 1 || epoch < 1) throw new Error("invalid retry acknowledgement");
      result = { type: "retryAck", requestId, epoch };
    } else if (field === 13) {
      let requestId = 0,
        subscriptionId = 0;
      fields(payload, (f, k, r) => {
        if (f === 1 || f === 2) {
          requireKind(k, 0);
          if (f === 1) requestId = r.uint();
          else subscriptionId = r.uint();
        } else r.skip(k);
      });
      if (requestId < 1 || subscriptionId < 1)
        throw new Error("invalid subscription acknowledgement");
      result = { type: "subscribeAck", requestId, subscriptionId };
    } else if (field === 6) result = { type: "snapshot", snapshot: decodeSnapshot(payload) };
    else if (field === 9) result = { type: "processPage", page: decodePage(payload) };
    else if (field === 2) result = decodeHelloAck(payload);
    else {
      const error = { requestId: 0, subscriptionId: 0, code: "", message: "" };
      fields(payload, (f, k, r) => {
        if (f <= 2) {
          requireKind(k, 0);
          if (f === 1) error.requestId = r.uint();
          else error.subscriptionId = r.uint();
        } else if (f === 3 || f === 4) {
          requireKind(k, 2);
          if (f === 3) error.code = r.string();
          else error.message = r.string();
        } else r.skip(k);
      });
      result = { type: "error", error };
    }
  });
  if (!result) throw new Error("missing monitor payload");
  return result;
}
