// Adapted from Orca (stablyai/orca, MIT) pane-terminal-foreground-render-settle.ts and the
// foreground refresh decisions in foreground-output-refresh.ts / fresh-spawn-follow-reset.ts at
// be4e0719.
import type { Terminal } from "@xterm/xterm";
import {
  nativeWindowsRewriteNeedsFollowupRenderRefresh,
  terminalOutputPrefersRenderRefresh,
  terminalRewriteOutputRenderRefreshDecision,
  windowsEastAsianOutputPrefersRenderRefresh,
} from "./terminalComplexScript";
import {
  disposeParsedDirtyRows,
  readParsedDirtyRowSpan,
  resetParsedDirtyRows,
  type ParsedDirtyRowSpan,
} from "./terminalParsedDirtyRows";

/** Orca's interactive redraw window and size bound. */
const INTERACTIVE_REDRAW_WINDOW_MS = 150;
const INTERACTIVE_REDRAW_CHARS = 128 * 1024;
const RISK_SCAN_TAIL_MAX = 64;

type RepairTerminal = Pick<Terminal, "buffer" | "rows" | "refresh"> & {
  _core?: { refresh?(start: number, end: number, sync?: boolean): void };
};

interface ViewportSnapshot {
  type: string;
  cursorY: number;
  baseY: number;
  viewportY: number;
}

export interface TerminalRenderRepairOptions {
  /** WebGL merges the repair into xterm's queued frame; the DOM renderer repaints now. */
  readonly isWebgl: () => boolean;
  readonly lastInputAt: () => number;
  /** Windows client (IME/East Asian commits) and native Windows ConPTY rewrite rules. */
  readonly windowsClient: boolean;
  readonly nativeWindowsConpty: boolean;
  readonly now?: () => number;
}

function trailingIncompleteEscape(data: string): string {
  const index = data.lastIndexOf("\x1b");
  if (index === -1 || data.length - index > RISK_SCAN_TAIL_MAX) return "";
  const tail = data.slice(index);
  return /[A-Za-z~]/.test(tail.slice(2)) ? "" : tail;
}

function capture(terminal: RepairTerminal): ViewportSnapshot {
  const active = terminal.buffer.active;
  return {
    type: active.type,
    cursorY: active.cursorY,
    baseY: active.baseY,
    viewportY: active.viewportY,
  };
}

function viewportMoved(before: ViewportSnapshot, after: ViewportSnapshot): boolean {
  return after.baseY !== before.baseY || after.viewportY !== before.viewportY;
}

/** The parse's dirty rows widened by the cursor rows (WebGL drops a cursor its pass skips). */
function repairSpan(
  terminal: RepairTerminal,
  before: ViewportSnapshot,
  after: ViewportSnapshot,
): ParsedDirtyRowSpan | null {
  if (before.type !== after.type || viewportMoved(before, after)) return null;
  const parsed = readParsedDirtyRowSpan(terminal);
  if (!parsed) return null;
  return {
    start: Math.min(parsed.start, before.cursorY, after.cursorY),
    end: Math.max(parsed.end, before.cursorY, after.cursorY),
  };
}

/**
 * xterm's buffer is right after an in-place rewrite or a background-filled redraw, but the visible
 * layer can keep stale cells until something repaints them. Repaint exactly the rows the write
 * touched once it parses, plus one follow-up frame when the write scrolled the viewport.
 */
export class TerminalRenderRepair {
  private rewriteState = {
    previousChunkEndsWithCarriageReturn: false,
    previousRewriteCsiScanTail: "",
  };
  private riskTail = "";
  private followup: number | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(
    private readonly terminal: RepairTerminal,
    private readonly options: TerminalRenderRepairOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  /** Call right before a visible write; returns the step to run when xterm parsed it. */
  prepare(data: string): (() => void) | undefined {
    if (this.disposed || data.length === 0) return undefined;
    const decision = terminalRewriteOutputRenderRefreshDecision(data, this.rewriteState);
    this.rewriteState = {
      previousChunkEndsWithCarriageReturn: decision.nextChunkEndsWithCarriageReturn,
      previousRewriteCsiScanTail: decision.nextRewriteCsiScanTail,
    };
    const riskData = this.riskTail ? `${this.riskTail}${data}` : data;
    this.riskTail = trailingIncompleteEscape(riskData);
    const recentInput = this.now() - this.options.lastInputAt() <= INTERACTIVE_REDRAW_WINDOW_MS;
    const refresh =
      terminalOutputPrefersRenderRefresh(riskData) ||
      decision.prefersRenderRefresh ||
      windowsEastAsianOutputPrefersRenderRefresh(data, {
        isWindowsClient: this.options.windowsClient,
        isNativeWindowsConpty: this.options.nativeWindowsConpty,
        hadRecentInput: recentInput,
        maxInteractiveRedrawChars: INTERACTIVE_REDRAW_CHARS,
      });
    if (!refresh) return undefined;
    const forceFollowup = nativeWindowsRewriteNeedsFollowupRenderRefresh({
      isNativeWindowsConpty: this.options.nativeWindowsConpty,
      isForeground: true,
      isInPlaceRewrite: decision.prefersRenderRefresh,
    });
    const before = capture(this.terminal);
    // Reset here, not in the callback: the span must cover only this write's parse.
    resetParsedDirtyRows(this.terminal);
    return () => {
      if (this.disposed) return;
      const after = capture(this.terminal);
      this.refreshRows(repairSpan(this.terminal, before, after));
      if (forceFollowup || viewportMoved(before, after)) this.scheduleFollowup();
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.followup !== null) cancelAnimationFrame(this.followup);
    this.followup = null;
    disposeParsedDirtyRows(this.terminal);
  }

  private scheduleFollowup(): void {
    if (this.followup !== null) cancelAnimationFrame(this.followup);
    // Chromium can paint a freshly scrolled top row one frame after xterm finished parsing.
    this.followup = requestAnimationFrame(() => {
      this.followup = null;
      if (!this.disposed) this.refreshRows(null);
    });
  }

  private refreshRows(span: ParsedDirtyRowSpan | null): void {
    const rows = this.terminal.rows;
    if (rows < 1) return;
    const last = rows - 1;
    // Never widen to the whole grid needlessly: xterm unions refresh ranges per frame.
    const start = span ? Math.min(Math.max(span.start, 0), last) : 0;
    const end = span ? Math.min(Math.max(span.end, start), last) : last;
    try {
      const core = this.terminal._core;
      if (!this.options.isWebgl() && typeof core?.refresh === "function") {
        core.refresh(start, end, true);
        return;
      }
      this.terminal.refresh(start, end);
    } catch {
      /* Output can race view disposal; a missed repair is repainted by the next frame. */
    }
  }
}
