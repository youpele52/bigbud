import type { Terminal } from "@xterm/xterm";
import type { TerminalLiveModes } from "@bigbud/contracts/workspace/terminal.ts";

type Geometry = { cols: number; rows: number };
/** The program must observe the probe size, or Node-style TTYs coalesce both signals. */
const REDRAW_MIN_MS = 150;
const REDRAW_MAX_MS = 750;

/**
 * Modes a view must re-assert before attaching live without a history baseline. The screen
 * switch goes first: the server sequence may end by re-opening a control split at the cut.
 */
export function liveModeSequence(
  terminal: Pick<Terminal, "buffer">,
  modes: TerminalLiveModes | undefined,
): string {
  if (!modes) return "";
  const alternate = terminal.buffer.active.type === "alternate";
  if (modes.alternateScreen === alternate) return modes.sequence;
  return (modes.alternateScreen ? "\x1b[?1049h" : "\x1b[?1049l") + modes.sequence;
}

/**
 * Asks a surviving program to repaint by shrinking its PTY one row, then restoring the view's
 * geometry. Unix programs receive SIGWINCH; ConPTY re-emits its own screen. Nothing restarts,
 * and output that scrolled past cannot be recovered this way.
 */
export class TerminalRedrawNudge {
  private settle: (() => void) | null = null;
  private running = false;

  constructor(
    private readonly resize: (geometry: Geometry) => Promise<unknown>,
    private readonly geometry: () => Geometry,
  ) {}

  /** Output after the shrink shows the program reacted, so the probe size can end early. */
  observeOutput(): void {
    this.settle?.();
  }

  async request(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const initial = this.geometry();
    try {
      const rows = initial.rows > 1 ? initial.rows - 1 : initial.rows + 1;
      await this.resize({ cols: initial.cols, rows });
      await new Promise<void>((resolve) => {
        let minimumElapsed = false;
        let reacted = false;
        const finish = () => {
          clearTimeout(minimum);
          clearTimeout(maximum);
          this.settle = null;
          resolve();
        };
        const minimum = setTimeout(() => {
          minimumElapsed = true;
          if (reacted) finish();
        }, REDRAW_MIN_MS);
        const maximum = setTimeout(finish, REDRAW_MAX_MS);
        this.settle = () => {
          reacted = true;
          if (minimumElapsed) finish();
        };
      });
    } catch {
      // An exited process or a lost transport leaves nothing to repaint.
    } finally {
      this.settle = null;
      // Always restore, even if the view went away: the PTY must not keep the probe size.
      await this.resize(this.currentGeometry(initial)).catch(() => undefined);
      this.running = false;
    }
  }

  private currentGeometry(fallback: Geometry): Geometry {
    try {
      return this.geometry();
    } catch {
      return fallback;
    }
  }
}
