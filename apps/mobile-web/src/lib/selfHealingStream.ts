type StreamRunCallbacks = {
  readonly onExit: () => void;
};

type StartStreamRun = (callbacks: StreamRunCallbacks) => () => void;
type TimerId = ReturnType<typeof globalThis.setTimeout>;

export type SelfHealingStreamOptions = {
  readonly scheduleRestart?: (restart: () => void) => void;
  readonly restartDelaysMs?: ReadonlyArray<number>;
  readonly setTimeout?: (callback: () => void, delayMs: number) => TimerId;
  readonly clearTimeout?: (timerId: TimerId) => void;
  readonly maxRestarts?: number;
  readonly onExhausted?: () => void;
};

const scheduleRestartInMicrotask = (restart: () => void) => {
  queueMicrotask(restart);
};

const DEFAULT_RESTART_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export class SelfHealingStream {
  private active = false;
  private runToken = 0;
  private cancelCurrentRun: (() => void) | null = null;
  private readonly scheduleRestart: (restart: () => void) => void;
  private readonly restartDelaysMs: ReadonlyArray<number>;
  private readonly setTimeout: (callback: () => void, delayMs: number) => TimerId;
  private readonly clearTimeout: (timerId: TimerId) => void;
  private readonly hasCustomRestartScheduler: boolean;
  private readonly maxRestarts: number;
  private readonly onExhausted: (() => void) | undefined;
  private restartTimer: TimerId | null = null;
  private restartOrdinal = 0;

  constructor(
    private readonly startStreamRun: StartStreamRun,
    options?: SelfHealingStreamOptions,
  ) {
    this.scheduleRestart = options?.scheduleRestart ?? scheduleRestartInMicrotask;
    this.hasCustomRestartScheduler = options?.scheduleRestart !== undefined;
    this.restartDelaysMs = options?.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.setTimeout =
      options?.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimeout = options?.clearTimeout ?? ((timerId) => globalThis.clearTimeout(timerId));
    this.maxRestarts = options?.maxRestarts ?? 7;
    this.onExhausted = options?.onExhausted;
  }

  start() {
    this.active = true;
    if (this.cancelCurrentRun !== null) {
      return;
    }

    if (this.restartTimer !== null) {
      this.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const runToken = ++this.runToken;
    let stoppedByOwner = false;
    let exitedSynchronously = false;
    const cancelRun = this.startStreamRun({
      onExit: () => {
        if (this.runToken !== runToken) {
          return;
        }
        exitedSynchronously = this.cancelCurrentRun === null;
        this.cancelCurrentRun = null;
        if (stoppedByOwner || !this.active) {
          return;
        }
        this.scheduleBoundedRestart();
      },
    });

    if (!exitedSynchronously) {
      this.cancelCurrentRun = () => {
        if (this.runToken !== runToken) {
          cancelRun();
          return;
        }
        stoppedByOwner = true;
        this.cancelCurrentRun = null;
        cancelRun();
      };
    }
  }

  private scheduleBoundedRestart() {
    if (!this.active || this.restartTimer !== null) return;
    if (this.restartOrdinal >= this.maxRestarts) {
      this.active = false;
      this.onExhausted?.();
      return;
    }
    const delay = this.restartDelaysMs[this.restartOrdinal] ?? this.restartDelaysMs.at(-1) ?? 0;
    this.restartOrdinal += 1;
    const restart = () => {
      this.restartTimer = null;
      if (!this.active || this.cancelCurrentRun !== null) return;
      this.start();
    };
    if (this.hasCustomRestartScheduler) {
      this.scheduleRestart(restart);
      return;
    }
    this.restartTimer = this.setTimeout(restart, delay);
  }

  stop() {
    this.active = false;
    this.restartOrdinal = 0;
    if (this.restartTimer !== null) {
      this.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const cancelRun = this.cancelCurrentRun;
    this.cancelCurrentRun = null;
    cancelRun?.();
  }
}
