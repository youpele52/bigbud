// Orca's foreground/background output pacing (pane-terminal-output-queue-registry.ts and
// foreground-output-budgets.ts, stablyai/orca MIT at be4e0719).

/** Visible output this small is echo-like and is written without a scheduler hop. */
export const FOREGROUND_IMMEDIATE_CHARS = 2048;
/** Larger visible redraws are immediate only right after input and when they carry ANSI. */
export const FOREGROUND_INTERACTIVE_REDRAW_CHARS = 128 * 1024;
/** Rolling budget so many tiny redraws cannot starve timers and input. */
export const FOREGROUND_IMMEDIATE_BUDGET_CHARS = 128 * 1024;
export const FOREGROUND_BUDGET_WINDOW_MS = 500;

/** Hidden views: first flush waits, later drains are paced, at most two writes in flight. */
export const BACKGROUND_FLUSH_DELAY_MS = 50;
export const BACKGROUND_DRAIN_INTERVAL_MS = 16;
export const BACKGROUND_IN_FLIGHT_WRITES = 2;
/**
 * A hidden view this far behind drains without the initial delay. Orca uses 512 Ki chars against
 * its larger queue; bigbud's view lane is capped at 1 MiB encoded, so the threshold is half of it.
 */
export const BACKGROUND_LARGE_BACKLOG_BYTES = 512 * 1024;

export class ForegroundImmediateBudget {
  private chars = 0;
  private windowStart = -Infinity;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Orca's classifier: tiny chunks, or interactive ANSI redraws, within the rolling budget. */
  admit(data: string, latencySensitive: boolean): boolean {
    const eligible =
      data.length <= FOREGROUND_IMMEDIATE_CHARS ||
      (latencySensitive &&
        data.length <= FOREGROUND_INTERACTIVE_REDRAW_CHARS &&
        data.includes("\x1b["));
    if (!eligible) return false;
    const at = this.now();
    if (at - this.windowStart >= FOREGROUND_BUDGET_WINDOW_MS) {
      this.chars = 0;
      this.windowStart = at;
    }
    if (this.chars + data.length > FOREGROUND_IMMEDIATE_BUDGET_CHARS) return false;
    this.chars += data.length;
    return true;
  }
}
