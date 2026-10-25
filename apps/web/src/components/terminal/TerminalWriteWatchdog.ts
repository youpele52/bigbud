// Adapted from Orca (stablyai/orca, MIT) terminal-write-pipeline-health.ts at be4e0719.

export const WRITE_PIPELINE_STALL_CHECK_MS = 10_000;

export class TerminalPipelineStalledError extends Error {
  constructor() {
    super(
      "Terminal renderer stopped processing output. Reloading the view; the shell keeps running.",
    );
    this.name = "TerminalPipelineStalledError";
  }
}

/**
 * A view's xterm write pipeline can die while its PTY stays alive (an escaping throw wedges
 * xterm's WriteBuffer; writes to a disposed emulator drop their callbacks). A write without a
 * completion for `stallMs` triggers an empty FIFO probe write; xterm parses in order, so a
 * completing probe proves the parser is merely slow. A probe that stays silent for another
 * interval with no parse progress certifies the pipeline dead, once.
 */
export class TerminalWriteWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private progress = 0;
  private dead = false;
  private disposed = false;

  constructor(
    private readonly terminal: { write(data: string, callback?: () => void): void },
    private readonly onDead: () => void,
    private readonly stallMs = WRITE_PIPELINE_STALL_CHECK_MS,
    private readonly isPageVisible: () => boolean = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  ) {}

  /** A write was handed to xterm; keep an existing watch, otherwise start one. */
  arm(): void {
    if (this.dead || this.disposed || this.timer !== null) return;
    this.timer = setTimeout(() => this.probe(), this.stallMs);
  }

  /** A write's parse completed: the pipeline is healthy. */
  settle(): void {
    this.progress++;
    this.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private probe(): void {
    this.timer = null;
    if (this.dead || this.disposed) return;
    const since = this.progress;
    try {
      this.terminal.write("", () => {
        this.progress++;
        this.clear();
      });
    } catch {
      this.certify();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dead || this.disposed) return;
      // Hidden pages throttle timers (and xterm's own parse scheduling); never judge them.
      if (this.progress !== since || !this.isPageVisible()) {
        this.arm();
        return;
      }
      this.certify();
    }, this.stallMs);
  }

  private certify(): void {
    if (this.dead || this.disposed) return;
    this.dead = true;
    this.clear();
    try {
      this.onDead();
    } catch {
      /* Recovery is best effort; never throw from a timer. */
    }
  }
}
