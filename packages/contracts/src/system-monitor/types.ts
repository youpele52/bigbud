export interface MonitorDemand {
  processes: boolean;
  disks: boolean;
  sensors: boolean;
  appResources?: boolean;
}
export interface MonitorProcessRoot {
  pid: number;
  identity: string;
  startTimeSeconds?: number;
  role: "desktop" | "backend" | "native";
}
export interface MonitorAppGroup {
  role: "desktop" | "backend" | "native" | "tools";
  processCount: number;
  cpuPercent?: MonitorMetric;
  residentBytes?: MonitorMetric;
  readBytesPerSecond?: MonitorMetric;
  writtenBytesPerSecond?: MonitorMetric;
}
export interface MonitorAppResources {
  generation: number;
  sampledAtMs: number;
  incomplete: boolean;
  core: MonitorAppGroup;
  inclusive: MonitorAppGroup;
  groups: MonitorAppGroup[];
}
export interface MonitorMetric {
  value: number;
  status: "ready" | "warming" | "unsupported" | "denied" | "unavailable" | "stale";
  sampledAtMs: number;
}
export interface MonitorNamedMetric {
  name: string;
  metric: MonitorMetric;
}
export interface MonitorFlag {
  value: boolean;
  status: MonitorMetric["status"];
  sampledAtMs: number;
}
export interface MonitorTextField {
  value: string;
  status: MonitorMetric["status"];
  sampledAtMs: number;
}
export interface MonitorDisk {
  name: string;
  mount: string;
  filesystem: string;
  totalBytes?: MonitorMetric;
  freeBytes?: MonitorMetric;
  usedBytes?: MonitorMetric;
  readBytesPerSecond?: MonitorMetric;
  writtenBytesPerSecond?: MonitorMetric;
  removable?: MonitorFlag;
  readOnly?: MonitorFlag;
}
export interface MonitorNetworkInterface {
  name: string;
  receivedTotalBytes?: MonitorMetric;
  transmittedTotalBytes?: MonitorMetric;
  receivedBytesPerSecond?: MonitorMetric;
  transmittedBytesPerSecond?: MonitorMetric;
  receiveErrors?: MonitorMetric;
  transmitErrors?: MonitorMetric;
  receivedPackets?: MonitorMetric;
  transmittedPackets?: MonitorMetric;
  linkState?: MonitorTextField;
  mtuBytes?: MonitorMetric;
}
export interface MonitorSnapshot {
  appResources?: MonitorAppResources;
  subscriptionId: number;
  epoch: number;
  sequence: number;
  baseline: boolean;
  sampledAtMs: number;
  hostname: string;
  cpuPercent?: MonitorMetric;
  perCorePercent: MonitorNamedMetric[];
  memoryTotalBytes?: MonitorMetric;
  memoryUsedBytes?: MonitorMetric;
  memoryAvailableBytes?: MonitorMetric;
  swapTotalBytes?: MonitorMetric;
  swapUsedBytes?: MonitorMetric;
  swapFreeBytes?: MonitorMetric;
  networkReceivedBytesPerSecond?: MonitorMetric;
  networkTransmittedBytesPerSecond?: MonitorMetric;
  diskCapacityBytes?: MonitorMetric;
  temperaturesCelsius: MonitorNamedMetric[];
  criticalTemperaturesCelsius?: MonitorNamedMetric[];
  processStatus: string;
  summaryStatus: string;
  disks: MonitorDisk[];
  interfaces: MonitorNetworkInterface[];
  osName: string;
  osVersion: string;
  architecture: string;
  kernelVersion?: string;
  bootTimeSeconds?: MonitorMetric;
  physicalCores?: MonitorMetric;
  cpuBrand?: string;
  cpuFrequencyMhz?: MonitorMetric;
  loadAverageOne?: MonitorMetric;
  loadAverageFive?: MonitorMetric;
  loadAverageFifteen?: MonitorMetric;
  uptimeSeconds?: MonitorMetric;
  logicalCores?: MonitorMetric;
  perCoreTruncated: boolean;
  disksTruncated: boolean;
  interfacesTruncated: boolean;
  sensorsTruncated: boolean;
}
export interface MonitorProcessQuery {
  search?: string;
  name?: string;
  pid?: number;
  status?: string;
  sort: "cpu" | "memory" | "name" | "pid";
  descending: boolean;
  limit: number;
  cursor?: { generation: number; digest: string; offset: number };
}
export interface MonitorProcessRow {
  pid: number;
  parentPid?: number;
  name: string;
  status: string;
  startTimeSeconds: number;
  runTimeSeconds: number;
  cpuPercent?: MonitorMetric;
  residentBytes: number;
  virtualBytes: number;
  diskReadBytes: number;
  diskWrittenBytes: number;
}
export interface MonitorProcessPage {
  requestId: number;
  rows: MonitorProcessRow[];
  truncatedInventory: boolean;
  generation: number;
  nextDigest: string;
  nextOffset: number;
}
export interface MonitorError {
  requestId: number;
  subscriptionId: number;
  code: string;
  message: string;
}
export interface MonitorCollectionStatus {
  state: "healthy" | "retrying" | "failed";
  attempts: number;
  retryAfterMs: number;
  reason: string;
  epoch: number;
}
export type MonitorEvent =
  | { type: "subscribeAck"; requestId: number; subscriptionId: number }
  | { type: "retryAck"; requestId: number; epoch: number }
  | {
      type: "helloAck";
      major: number;
      minor: number;
      maximumFrameBytes: number;
      maximumSubscriptions: number;
      epoch: number;
      capabilities: string[];
      hostname?: string;
      osName?: string;
      osVersion?: string;
      architecture?: string;
    }
  | { type: "snapshot"; snapshot: MonitorSnapshot }
  | { type: "processPage"; page: MonitorProcessPage }
  | { type: "error"; error: MonitorError }
  | { type: "collectionStatus"; status: MonitorCollectionStatus }
  | { type: "unavailable"; reason: string };
export interface DesktopSystemMonitorBridge {
  systemMonitorSubscribe?: (demand: MonitorDemand) => Promise<number>;
  systemMonitorUpdate?: (subscriptionId: number, demand: MonitorDemand) => Promise<void>;
  systemMonitorUnsubscribe?: (subscriptionId: number) => Promise<void>;
  systemMonitorAck?: (subscriptionId: number, epoch: number, sequence: number) => Promise<void>;
  systemMonitorQuery?: (query: MonitorProcessQuery) => Promise<MonitorProcessPage>;
  systemMonitorRetry?: () => Promise<boolean>;
  onSystemMonitorEvent?: (listener: (event: MonitorEvent) => void) => () => void;
}
