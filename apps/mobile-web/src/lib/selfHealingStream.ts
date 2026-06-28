type StreamRunCallbacks = {
  readonly onExit: () => void;
};

type StartStreamRun = (callbacks: StreamRunCallbacks) => () => void;

type SelfHealingStreamOptions = {
  readonly scheduleRestart?: (restart: () => void) => void;
};

const scheduleRestartInMicrotask = (restart: () => void) => {
  queueMicrotask(restart);
};

export class SelfHealingStream {
  private active = false;
  private runToken = 0;
  private cancelCurrentRun: (() => void) | null = null;
  private readonly scheduleRestart: (restart: () => void) => void;

  constructor(
    private readonly startStreamRun: StartStreamRun,
    options?: SelfHealingStreamOptions,
  ) {
    this.scheduleRestart = options?.scheduleRestart ?? scheduleRestartInMicrotask;
  }

  start() {
    this.active = true;
    if (this.cancelCurrentRun !== null) {
      return;
    }

    const runToken = ++this.runToken;
    let stoppedByOwner = false;
    const cancelRun = this.startStreamRun({
      onExit: () => {
        if (this.runToken !== runToken) {
          return;
        }
        this.cancelCurrentRun = null;
        if (stoppedByOwner || !this.active) {
          return;
        }
        this.scheduleRestart(() => {
          if (!this.active || this.cancelCurrentRun !== null) {
            return;
          }
          this.start();
        });
      },
    });

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

  stop() {
    this.active = false;
    const cancelRun = this.cancelCurrentRun;
    this.cancelCurrentRun = null;
    cancelRun?.();
  }
}
