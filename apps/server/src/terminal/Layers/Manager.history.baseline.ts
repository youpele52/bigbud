import { TerminalControlScanner } from "./TerminalControlScanner";
import { TerminalModeTracker } from "./TerminalModeTracker";

/**
 * Replay-baseline helpers for the bounded history tail.
 *
 * A trimmed history is only replayable from a point where the screen can be rebuilt: a safe
 * baseline boundary (RIS, `CSI 2J` with home, `CSI ?1049h`/`?47h`/`?1047h`, `CSI 3J` after a
 * home/erase), or a line
 * boundary outside any open control sequence with the tracked SGR and modes prepended.
 */

/** The last control token seen, kept so `CSI H` + `CSI 2J` split across chunks still pairs. */
export interface BaselineToken {
  readonly kind: "home" | "erase" | "other";
  readonly start: number;
  readonly end: number;
}

export interface BaselineBoundaryScan {
  /** Newest safe baseline boundary (index of its first control byte), or null. */
  boundary: number | null;
  previous: BaselineToken | null;
}

// Complete controls only: sanitized history chunks never end inside one. Strings are consumed
// first, so control-like text inside an OSC/DCS payload is never taken for a boundary.
const TOKEN =
  // oxlint-disable-next-line no-control-regex -- Matching control sequences is the purpose.
  /\x1bc|(?:\x1b\[|\x9b)([0-?]*)[ -/]*([@-~])|(?:\x1b[\]P^_]|[\x90\x9d-\x9f])[\s\S]*?(?:\x07|\x9c|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex -- Matching control introducers is the purpose.
const INTRODUCER = /[\x1b\x90\x9b\x9d-\x9f]/;
const HOME_PARAMS = new Set(["", "1", ";", "1;", ";1", "1;1"]);
const ALTERNATE_SCREEN_MODES = new Set(["47", "1047", "1049"]);

/** Records the newest baseline boundary in `text`, which starts at history index `offset`. */
export function scanBaselineBoundaries(
  text: string,
  offset: number,
  scan: BaselineBoundaryScan,
): void {
  if (!INTRODUCER.test(text)) return;
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
    const start = offset + match.index;
    const end = start + match[0].length;
    const params = match[1];
    const final = match[2];
    const previous = scan.previous;
    const adjacent = previous !== null && previous.end === start;
    let kind: BaselineToken["kind"] = "other";
    if (match[0] === "\x1bc") scan.boundary = start;
    // ED3 clears only scrollback: it is a baseline only right after a home/erase (`clear`).
    else if (final === "J" && params === "3") {
      if (adjacent && previous.kind !== "other") scan.boundary = start;
    } else if (final === "J" && params === "2") {
      kind = "erase";
      if (adjacent && previous.kind === "home") scan.boundary = previous.start;
    } else if (
      (final === "H" || final === "f") &&
      params !== undefined &&
      HOME_PARAMS.has(params)
    ) {
      kind = "home";
      if (adjacent && previous.kind === "erase") scan.boundary = previous.start;
    } else if (
      final === "h" &&
      params?.startsWith("?") &&
      params
        .slice(1)
        .split(";")
        .some((mode) => ALTERNATE_SCREEN_MODES.has(mode))
    )
      scan.boundary = start;
    scan.previous = { kind, start, end };
  }
}

/** Rebases scan positions after `history.slice(cut)` was prefixed with `prefixLength` chars. */
export function rebaseBaselineScan(scan: BaselineBoundaryScan, cut: number, prefixLength: number) {
  const shift = prefixLength - cut;
  scan.boundary = scan.boundary !== null && scan.boundary >= cut ? scan.boundary + shift : null;
  const previous = scan.previous;
  scan.previous =
    previous !== null && previous.start >= cut
      ? { kind: previous.kind, start: previous.start + shift, end: previous.end + shift }
      : null;
}

/** UTF-8 bytes of `text[start, end)`, counting a lone surrogate as its 3-byte replacement. */
export function utf8Length(text: string, start = 0, end = text.length): number {
  let bytes = 0;
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function countNewlines(text: string, start = 0): number {
  let count = 0;
  for (let i = text.indexOf("\n", start); i !== -1; i = text.indexOf("\n", i + 1)) count++;
  return count;
}

/** Current graphic rendition, re-emitted as one canonical SGR sequence. */
class GraphicRendition {
  private flags = new Map<string, string>();

  reset(): void {
    this.flags.clear();
  }

  apply(body: string): void {
    // Private or prefixed `m` sequences (for example `CSI > 4 ; 1 m`) are not SGR.
    if (!/^[0-9;:]*$/.test(body)) return;
    const params = body === "" ? ["0"] : body.split(";");
    for (let index = 0; index < params.length; index++) {
      const param = params[index]!;
      const head = param.split(":")[0]!;
      if (param.includes(":")) {
        if (head === "4") this.set("underline", param === "4:0" ? null : param);
        else if (head === "38" || head === "48" || head === "58") this.set(head, param);
        continue;
      }
      const code = param === "" ? 0 : Number(param);
      if (code === 38 || code === 48 || code === 58) {
        const width = params[index + 1] === "5" ? 3 : params[index + 1] === "2" ? 5 : 0;
        if (width === 0 || index + width > params.length) return;
        this.set(String(code), params.slice(index, index + width).join(";"));
        index += width - 1;
      } else this.applyCode(code);
    }
  }

  private applyCode(code: number): void {
    if (code === 0) this.reset();
    else if (code === 1 || code === 2) this.set(`intensity${code}`, String(code));
    else if (code === 22) this.set("intensity1", null).set("intensity2", null);
    else if (code === 4 || code === 21) this.set("underline", String(code));
    else if (code === 5 || code === 6) this.set("blink", String(code));
    else if (code === 3 || code === 7 || code === 8 || code === 9 || code === 53)
      this.set(`flag${code}`, String(code));
    else if (code === 23 || code === 27 || code === 28 || code === 29)
      this.set(`flag${code - 20}`, null);
    else if (code === 24) this.set("underline", null);
    else if (code === 25) this.set("blink", null);
    else if (code === 55) this.set("flag53", null);
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.set("38", String(code));
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
      this.set("48", String(code));
    else if (code === 39) this.set("38", null);
    else if (code === 49) this.set("48", null);
    else if (code === 59) this.set("58", null);
  }

  private set(key: string, value: string | null): this {
    if (value === null) this.flags.delete(key);
    else this.flags.set(key, value);
    return this;
  }

  sequence(): string {
    return `\x1b[${["0", ...this.flags.values()].join(";")}m`;
  }
}

/** Follows SGR and input modes over replayed history, in xterm's control-sequence states. */
export class TerminalBaselineTracker {
  private readonly modes = new TerminalModeTracker();
  private readonly rendition = new GraphicRendition();
  private readonly scanner = new TerminalControlScanner(
    {
      csi: (body, final, overflow) => {
        if (overflow) return;
        if (final === 0x6d) this.rendition.apply(body);
        else if (final === 0x70 && body === "!") this.rendition.reset();
      },
      esc: (final) => {
        if (final === 0x63) this.rendition.reset();
      },
    },
    256,
  );

  receive(text: string, start: number, end: number): void {
    if (end <= start) return;
    const slice = text.slice(start, end);
    this.modes.receive(slice);
    this.scanner.receive(slice);
  }

  /** True when the bytes so far left no control sequence open. */
  get ground(): boolean {
    return this.scanner.state === "ground";
  }

  /** ASCII controls that put a fresh terminal into the tracked state. Only valid at ground. */
  preamble(): string {
    const modes = this.modes.snapshot();
    return (
      (modes.alternateScreen ? "\x1b[?1049h" : "") + modes.sequence + this.rendition.sequence()
    );
  }
}

/** Preamble for replaying `history` from `index`, or null if `index` is inside a control. */
export function baselinePreambleAt(history: string, index: number): string | null {
  const tracker = new TerminalBaselineTracker();
  tracker.receive(history, 0, index);
  return tracker.ground ? tracker.preamble() : null;
}

export interface TerminalHistoryLineCut {
  readonly index: number;
  readonly preamble: string;
  readonly droppedBytes: number;
  readonly droppedNewlines: number;
}

/**
 * First line boundary outside any open control sequence that drops at least `minBytes` UTF-8
 * bytes and `minNewlines` newlines. Null when no such boundary exists; the caller must then
 * treat the baseline as lost rather than replay a mid-line or mid-sequence suffix.
 */
export function findTerminalHistoryLineCut(
  history: string,
  minBytes: number,
  minNewlines: number,
): TerminalHistoryLineCut | null {
  let index = 0;
  let bytes = 0;
  let newlines = 0;
  while (index < history.length && (bytes < minBytes || newlines < minNewlines)) {
    const code = history.charCodeAt(index);
    const next = history.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      bytes += 4;
      index += 2;
      continue;
    }
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (code === 0x0a) newlines++;
    index++;
  }
  const tracker = new TerminalBaselineTracker();
  tracker.receive(history, 0, index);
  const cut = () => ({
    index,
    preamble: tracker.preamble(),
    droppedBytes: bytes,
    droppedNewlines: newlines,
  });
  if (index > 0 && history.charCodeAt(index - 1) === 0x0a && tracker.ground) return cut();
  for (;;) {
    const newline = history.indexOf("\n", index);
    if (newline === -1) return null;
    tracker.receive(history, index, newline + 1);
    bytes += utf8Length(history, index, newline + 1);
    newlines++;
    index = newline + 1;
    if (tracker.ground) return cut();
  }
}
