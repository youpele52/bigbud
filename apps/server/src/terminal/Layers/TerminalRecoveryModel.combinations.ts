import type { Terminal } from "@xterm/headless";
import { TerminalControlScanner } from "./TerminalControlScanner";
import { RECOVERY_COMBINED_BYTES } from "./TerminalRecoveryModel.budget";

/** Joined codepoints one printed run may stack onto a cell. Stream-safe Unicode needs 30. */
export const RECOVERY_CLUSTER_JOINERS = 32;
/** Pinned xterm allocates `Uint32Array(text.length * Ps)` for REP before printing. */
export const RECOVERY_REP_ALLOCATION_BYTES = 1024 * 1024;
const ENTRY_BYTES = 64; // Estimated sparse-map slot plus string header per retained entry.
const AUDIT_INTERVAL_BYTES = 256 * 1024;
const MAX_PARAM = 0x7fffffff; // The pinned parser clamps parameters here.
// oxlint-disable-next-line no-control-regex -- The ASCII range is the boundary being matched.
const NON_ASCII = /[^\u0000-\u007f]/g;

interface Line {
  _combined?: Record<number, string>;
}
interface Lines {
  readonly length: number;
  get(index: number): Line | undefined;
}
interface Core {
  unicodeService?: { wcwidth(codepoint: number): number };
  _bufferService?: { buffers?: { normal?: { lines?: Lines }; alt?: { lines?: Lines } } };
}

/**
 * Bounds the strings pinned xterm retains for combined cells, before the parser allocates them.
 *
 * In the pinned build a cell's string only grows while one printed run keeps joining onto it:
 * every control resets the join state, and printing a base character over a cell replaces its
 * string. So a per-run cap bounds each string, REP is checked before its allocation, and an
 * exact inventory of both buffers bounds the total, including stale and scrollback entries.
 * The run here never resets on controls, so it can only over-count xterm's joins.
 */
export class TerminalRecoveryUnicodeAdmission {
  private readonly wcwidth: (codepoint: number) => number;
  private readonly buffers: readonly Lines[];
  private readonly scanner = new TerminalControlScanner({
    text: (data, start, end) => this.text(data, start, end),
    csi: (body, final, overflow) => this.csi(body, final, overflow),
  });
  private run = 0;
  private afterZwj = false;
  private high = 0;
  private unaudited = 0;
  private failure: string | null = null;

  constructor(terminal: Terminal) {
    const core = (terminal as unknown as { _core?: Core })._core;
    const service = core?.unicodeService;
    const buffers = core?._bufferService?.buffers;
    const normal = buffers?.normal?.lines;
    const alt = buffers?.alt?.lines;
    if (
      typeof service?.wcwidth !== "function" ||
      typeof normal?.get !== "function" ||
      typeof alt?.get !== "function" ||
      typeof normal.get(0)?._combined !== "object"
    )
      throw new Error("Unsupported Unicode admission profile");
    this.wcwidth = (codepoint) => service.wcwidth(codepoint);
    this.buffers = [normal, alt];
  }

  /** Scans output in parse order. Returns a retirement reason before xterm sees the chunk. */
  admit(data: string): string | null {
    if (this.high) {
      const next = data.charCodeAt(0);
      if (!(next >= 0xdc00 && next <= 0xdfff)) this.high = 0;
    }
    this.scanner.receive(data);
    return this.failure;
  }

  /** Exact inventory once enough growth is possible; cheap counters decide when. */
  auditIfDue(): string | null {
    if (this.unaudited < AUDIT_INTERVAL_BYTES) return null;
    this.unaudited = 0;
    return this.retainedBytes() > RECOVERY_COMBINED_BYTES ? "unicode-retained-budget" : null;
  }

  retainedBytes(): number {
    let bytes = 0;
    for (const lines of this.buffers) {
      for (let index = 0; index < lines.length; index++) {
        const combined = lines.get(index)?._combined;
        for (const key in combined)
          bytes += combined[key as unknown as number]!.length * 2 + ENTRY_BYTES;
      }
    }
    return bytes;
  }

  private text(data: string, start: number, end: number): void {
    let index = start;
    while (index < end && !this.failure) {
      if (this.run === 0 && !this.afterZwj && this.high === 0) {
        // Plain ASCII neither joins nor changes the run while nothing is pending.
        NON_ASCII.lastIndex = index;
        const match = NON_ASCII.exec(data);
        if (!match || match.index >= end) return;
        index = match.index;
      }
      let code = data.charCodeAt(index++);
      if (this.high) {
        if (code >= 0xdc00 && code <= 0xdfff) code = this.combine(this.high, code);
        this.high = 0;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const low = index < end ? data.charCodeAt(index) : -1;
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = this.combine(code, low);
          index++;
        } else {
          // Xterm's decoder keeps a chunk-final high surrogate for the next write.
          if (index === data.length) this.high = code;
          continue;
        }
      }
      // Unpaired surrogates neither join nor reset: only counting can stay conservative.
      if (code >= 0xd800 && code <= 0xdfff) continue;
      this.codepoint(code);
    }
  }

  private combine(high: number, low: number): number {
    return (high - 0xd800) * 0x400 + low - 0xdc00 + 0x10000;
  }

  private codepoint(code: number): void {
    // C0 controls execute, DEL is ignored and print() skips soft hyphens: none touch the cell.
    if (code < 0x20 || code === 0x7f || code === 0xad) return;
    // Unicode 11 joins only zero-width codepoints; bigbud's provider also joins after a ZWJ.
    const joins = this.afterZwj || (code > 0x7f && this.wcwidth(code) === 0);
    this.afterZwj = code === 0x200d;
    if (!joins) {
      this.run = 0;
      return;
    }
    this.grow(1);
  }

  /** REP repeats the last grapheme, which the run bounds at `run + 1` codepoints. */
  private csi(body: string, final: number, overflow: boolean): void {
    if (final !== 0x62 || this.failure) return;
    for (let index = 0; index < body.length; index++) {
      const code = body.charCodeAt(index);
      if (code < 0x30 || (index === 0 && code >= 0x3c && code <= 0x3f)) return;
    }
    const first = Number(body.split(/[;:]/, 1)[0]);
    const count = overflow ? MAX_PARAM : Math.min(first || 1, MAX_PARAM);
    const cell = this.run + 1;
    if (cell * 2 * 4 * count > RECOVERY_REP_ALLOCATION_BYTES) {
      this.failure = "rep-expansion-budget";
      return;
    }
    // After a ZWJ each repetition joins the previous one, stacking onto a single cell.
    if (this.afterZwj) this.grow(cell * count);
    else if (this.run > 0) this.unaudited += count * (cell * 8 + ENTRY_BYTES);
  }

  private grow(joiners: number): void {
    this.run += joiners;
    this.unaudited += joiners * (8 + ENTRY_BYTES);
    if (this.run > RECOVERY_CLUSTER_JOINERS) this.failure = "unicode-cluster-budget";
  }
}
