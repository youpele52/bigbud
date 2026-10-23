/**
 * Shapes shared by the sleep-and-wake probe. Every input is read from an existing
 * source (trace file, desktop log, OS power log, read-only state SQLite, provider
 * logs, a marker file written by the test tool) or sampled by the probe itself.
 */

export const SLEEP_WAKE_ROW_SCHEMA = "bigbud.sleep-wake-probe/1";

export type ProbeScenario = "streaming" | "tool";
export type ProbeTopology = "local" | "ssh-remote";
export type ProbeBuild = "dev" | "packaged";

/** One tick of the probe's own clocks. `monoMs` comes from `performance.now()`. */
export interface ClockSample {
  readonly wallMs: number;
  readonly monoMs: number;
}

/**
 * Maps trace time to wall time. Server span timestamps are process start time plus
 * `process.hrtime`. On Linux hrtime stops during sleep, so after a sleep the trace runs
 * behind the wall clock; on macOS (libuv uses `mach_continuous_time`) and Windows it counts
 * sleep, so the drift is near zero. The probe pairs the trace file's mtime (wall) with the
 * newest span end it contains (trace time) to recover the offset.
 */
export interface TraceOffsetSample {
  readonly wallMs: number;
  readonly traceMs: number;
}

export interface TraceSpan {
  readonly name: string;
  /** Trace time, not yet corrected to wall time. */
  readonly startMs: number;
  readonly endMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export type PowerSignalKind =
  | "suspend"
  | "resume"
  | "lock-screen"
  | "unlock-screen"
  | "online"
  | "offline"
  | "os-sleep"
  | "os-wake";

export interface PowerSignal {
  readonly kind: PowerSignalKind;
  readonly atMs: number;
  readonly source: "desktop-log" | "os-log";
}

export interface OrchestrationEventRow {
  readonly sequence: number;
  readonly eventType: string;
  readonly streamId: string;
  readonly occurredAtMs: number;
  readonly payload: unknown;
}

export interface ProviderLogLine {
  readonly atMs: number;
  readonly channel: string;
  readonly text: string;
}

export interface MarkerLine {
  readonly kind: "start" | "done";
  readonly atMs: number;
}

export interface ProviderVersionInfo {
  readonly provider: string;
  readonly version: string | null;
  readonly source: string;
}

/** Written by `start` before the lid closes, so `analyze` can run later or elsewhere. */
export interface ProbeRunMeta {
  readonly runId: string;
  readonly label: string | null;
  readonly scenario: ProbeScenario;
  readonly topology: ProbeTopology;
  readonly plannedSleepMinutes: number | null;
  readonly build: ProbeBuild;
  readonly stateDir: string;
  readonly desktopLogPath: string | null;
  readonly markerPath: string | null;
  readonly threadId: string | null;
  readonly startedAtMs: number;
  /** `max(sequence)` of `orchestration_events` when the probe started. */
  readonly startSequence: number;
  readonly platform: NodeJS.Platform;
  readonly osRelease: string;
}

/** Everything `analyze` needs, already read from disk. Pure input for tests. */
export interface ProbeInputs {
  readonly meta: ProbeRunMeta;
  readonly finishedAtMs: number;
  readonly clock: ReadonlyArray<ClockSample>;
  readonly traceOffsets: ReadonlyArray<TraceOffsetSample>;
  readonly spans: ReadonlyArray<TraceSpan>;
  readonly signals: ReadonlyArray<PowerSignal>;
  readonly events: ReadonlyArray<OrchestrationEventRow>;
  readonly providerLog: ReadonlyArray<ProviderLogLine>;
  readonly marker: ReadonlyArray<MarkerLine> | null;
  readonly providerVersion: ProviderVersionInfo | null;
  /** Sources that could not be read, with the reason. Copied into `notes`. */
  readonly unavailable: ReadonlyArray<string>;
}

export interface SleepWindow {
  readonly sleptAtMs: number;
  readonly wokeAtMs: number;
  readonly wallGapMs: number;
  readonly monotonicGapMs: number;
  /** Short awake slices inside the sleep (macOS DarkWake), merged into one window. */
  readonly darkWakes: number;
}

/**
 * - `finished-before-sleep`: the run is invalid; the lid closed too late.
 * - `finished-during-sleep`: the turn ended while the machine slept (remote work).
 * - `continued`: progress after wake and a clean finish, no retry evidence.
 * - `retried-internally`: clean finish after wake with provider retry evidence.
 * - `errored`: the turn or session ended in error or interruption after wake.
 * - `hung`: still running at the end with no progress for the hang threshold.
 * - `still-running`: still making progress; finish the probe later.
 * - `no-sleep`: the probe saw no sleep, so the turn says nothing about wake. Takes
 *   precedence over `no-turn`.
 * - `no-turn`: the machine slept, but no turn started after the probe did.
 */
export type TurnOutcome =
  | "no-turn"
  | "no-sleep"
  | "finished-before-sleep"
  | "finished-during-sleep"
  | "continued"
  | "retried-internally"
  | "errored"
  | "hung"
  | "still-running";

export interface SleepWakeRunRow {
  readonly schema: typeof SLEEP_WAKE_ROW_SCHEMA;
  readonly runId: string;
  readonly label: string | null;
  readonly recordedAt: string;
  readonly platform: string;
  readonly osRelease: string;
  readonly build: ProbeBuild;
  readonly topology: ProbeTopology;
  readonly scenario: ProbeScenario;
  readonly plannedSleepMinutes: number | null;
  readonly provider: string | null;
  readonly providerVersion: string | null;
  readonly providerVersionSource: string | null;
  readonly model: string | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly sleep: {
    readonly detected: boolean;
    readonly sleptAt: string | null;
    readonly wokeAt: string | null;
    readonly wallGapMs: number | null;
    readonly monotonicGapMs: number | null;
    readonly darkWakes: number | null;
    /** How far server span timestamps fell behind wall time across this sleep. */
    readonly serverClockDriftMs: number | null;
    readonly osSleepAt: string | null;
    readonly osWakeAt: string | null;
  };
  readonly signals: {
    readonly source: "desktop-log" | "unavailable";
    readonly suspendAt: string | null;
    readonly resumeAt: string | null;
    readonly onlineAt: string | null;
    readonly offlineAt: string | null;
    readonly resumeAfterWakeMs: number | null;
  };
  readonly reconnect: {
    /** A close, error or heartbeat report, or a socket that ended after the sleep. */
    readonly socketDropped: boolean;
    readonly oldSocketEndedAfterWakeMs: number | null;
    /** From the renderer's `reconnect-success` report, stamped in renderer wall time. */
    readonly reconnectSuccessAfterWakeMs: number | null;
    readonly closeReports: number;
    readonly heartbeatFailures: number;
    readonly stalls: number;
    readonly maxStallMs: number | null;
    readonly suspectedSleepEvents: number;
  };
  readonly turn: {
    readonly outcome: TurnOutcome;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly firstProgressAfterWakeMs: number | null;
    readonly endedAfterWakeMs: number | null;
    readonly lastSessionStatus: string | null;
    readonly lastError: string | null;
    readonly retryEvidence: ReadonlyArray<string>;
  };
  readonly tools: {
    readonly started: number;
    readonly completed: number;
    readonly markerStarts: number | null;
    readonly markerDones: number | null;
    readonly ranTwice: boolean | null;
  };
  readonly notes: ReadonlyArray<string>;
}
