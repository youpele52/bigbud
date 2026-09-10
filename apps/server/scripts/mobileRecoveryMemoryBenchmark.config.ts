export const RESULT_PREFIX = "MOBILE_RECOVERY_MEMORY_RESULT ";
export const DEFAULT_OUTPUT = "/tmp/bigbud-mobile-scale-audit/mobile-recovery-memory.json";
export const CAPTURE_CAPACITY = 2_000;
export const CAPTURE_BYTES = 4 * 1024 * 1024;
export const PRESEEDED_BACKLOG_EVENTS = 1_001;
export const SMALL_PAYLOAD_BYTES = 512;
export const LARGE_PAYLOAD_BYTES = 16 * 1024;
export const COUNT_OVERFLOW_EVENTS = CAPTURE_CAPACITY + 1;
export const DISPATCH_SAMPLES = 300;
export const MEMORY_RATIO_GATE = 2;
export const WORKER_TIMEOUT_MS = 120_000;

export const scenarios = [
  {
    name: "control-drain",
    mode: "control",
    count: DISPATCH_SAMPLES,
    payloadBytes: SMALL_PAYLOAD_BYTES,
  },
  {
    name: "capture-drain",
    mode: "recovery",
    count: DISPATCH_SAMPLES,
    payloadBytes: SMALL_PAYLOAD_BYTES,
  },
  {
    name: "control-count",
    mode: "control",
    count: COUNT_OVERFLOW_EVENTS,
    payloadBytes: SMALL_PAYLOAD_BYTES,
  },
  {
    name: "count-overflow",
    mode: "recovery",
    count: COUNT_OVERFLOW_EVENTS,
    payloadBytes: SMALL_PAYLOAD_BYTES,
  },
  {
    name: "control-byte",
    mode: "control",
    count: DISPATCH_SAMPLES,
    payloadBytes: LARGE_PAYLOAD_BYTES,
  },
  {
    name: "byte-overflow",
    mode: "recovery",
    count: DISPATCH_SAMPLES,
    payloadBytes: LARGE_PAYLOAD_BYTES,
  },
] as const;

export type Scenario = (typeof scenarios)[number];

export type TimingSummary = {
  readonly count: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

export type RecoverySummary = {
  readonly batchCount: number;
  readonly replayEventCount: number;
  readonly liveEventCount: number;
  readonly caughtUpThroughSequence: number | null;
  readonly resyncReasons: ReadonlyArray<string>;
};

type MemorySnapshot = ReturnType<typeof process.memoryUsage>;

export type BenchmarkResult = {
  readonly name: string;
  readonly mode: "control" | "recovery";
  readonly count: number;
  readonly payloadBytes: number;
  readonly preseedDispatch: TimingSummary;
  readonly dispatch: TimingSummary;
  readonly replay: {
    readonly pages: number;
    readonly events: number;
    readonly latestSequence: number;
  } | null;
  readonly recovery: RecoverySummary | null;
  readonly semanticPass: boolean;
  readonly memory: {
    readonly before: MemorySnapshot;
    readonly after: MemorySnapshot;
    readonly afterGc: MemorySnapshot;
    readonly sampleCount: number;
    readonly processHighWaterRssRaw: number;
    readonly sampledMaxHeapUsed: number;
    readonly sampledMaxRss: number;
  };
  readonly runtime: { readonly bun: string; readonly platform: string; readonly arch: string };
  readonly scope: string;
};
