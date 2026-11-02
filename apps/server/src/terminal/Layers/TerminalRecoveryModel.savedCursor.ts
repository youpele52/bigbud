import type { IBuffer, Terminal } from "@xterm/headless";
import { RECOVERY_SNAPSHOT_BYTES } from "./TerminalRecoveryModel.budget";

type Charset = Record<string, string> | undefined;
interface Attributes {
  fg: number;
  bg: number;
}
interface SavedBuffer {
  savedX: number;
  savedY: number;
  ybase: number;
  savedCurAttrData: Attributes;
  savedCharsets: Charset[];
  savedGlevel: number;
  savedOriginMode: boolean;
  savedWraparoundMode: boolean;
}
interface Core {
  _bufferService: { buffers: { normal: SavedBuffer; alt: SavedBuffer } };
  _inputHandler: { _curAttrData: Attributes };
  _charsetService: { charsets: Charset[]; glevel: number };
}

// Exact DEC table from the pinned xterm profile, not a heuristic based on one glyph.
const DEC = "◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·";
function charsetSequence(sets: Charset[], level: number): string | null {
  if (!Array.isArray(sets) || sets.length > 4 || !Number.isInteger(level) || level < 0 || level > 3)
    return null;
  // ANSI cannot shrink the designation array; partial tables alter future restore semantics.
  if (sets.length !== 0 && sets.length !== 4) return null;
  if (sets.length === 0) return level === 0 ? "\x0f" : null;
  let result = "";
  for (let i = 0; i < 4; i++) {
    const set = sets[i];
    const dec =
      set &&
      Object.keys(set).length === DEC.length &&
      [...DEC].every((value, index) => set[String.fromCharCode(96 + index)] === value);
    if (set !== undefined && !dec) return null;
    result += `\x1b${"()*+"[i]}${dec ? "0" : "B"}`;
  }
  return result + ["\x0f", "\x0e", "\x1bn", "\x1bo"][level];
}

/** Encode only the pinned non-extended SGR profile; unsupported bits never silently disappear. */
function attributesSequence(attr: Attributes): string | null {
  if (
    !attr ||
    !Number.isInteger(attr.fg) ||
    !Number.isInteger(attr.bg) ||
    attr.bg & 0xb0000000 ||
    attr.fg & 0x10000000
  )
    return null;
  const codes = ["0"];
  for (const [bits, flags] of [
    [
      attr.fg,
      [
        [0x4000000, 7],
        [0x8000000, 1],
        [0x10000000, 4],
        [0x20000000, 5],
        [0x40000000, 8],
        [0x80000000, 9],
      ],
    ],
    [
      attr.bg,
      [
        [0x4000000, 3],
        [0x8000000, 2],
        [0x40000000, 53],
      ],
    ],
  ] as const)
    for (const [mask, code] of flags) if (bits & mask) codes.push(String(code));
  for (const [bits, base] of [
    [attr.fg, 38],
    [attr.bg, 48],
  ]) {
    const mode = (bits! >>> 24) & 3;
    const color = bits! & 0xffffff;
    if (mode === 0 && color !== 0) return null;
    if (mode === 1) {
      if (color > 15) return null;
      codes.push(String((base === 38 ? 30 : 40) + (color < 8 ? color : color + 52)));
    }
    if (mode === 2) {
      if (color > 255) return null;
      codes.push(`${base};5;${color}`);
    }
    if (mode === 3) codes.push(`${base};2;${color >>> 16};${(color >>> 8) & 255};${color & 255}`);
  }
  return `\x1b[${codes.join(";")}m`;
}

/** Stock serialization omits trailing null cells, including their erase background. */
function emptyBackgrounds(buffer: IBuffer, cols: number, rows: number): string | null {
  let ansi = "";
  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(buffer.baseY + row);
    if (!line) continue;
    for (let col = 0; col < cols; ) {
      const cell = line.getCell(col);
      if (!cell || cell.getChars() !== "" || cell.getWidth() !== 1) {
        col++;
        continue;
      }
      const { fg, bg } = cell as unknown as Attributes;
      if (fg !== 0 || (bg & ~0x3ffffff) !== 0) return null;
      const sgr = attributesSequence({ fg, bg });
      if (sgr === null) return null;
      let end = col + 1;
      while (end < cols) {
        const next = line.getCell(end);
        if (
          !next ||
          next.getChars() !== "" ||
          next.getWidth() !== 1 ||
          (next as unknown as Attributes).fg !== fg ||
          (next as unknown as Attributes).bg !== bg
        )
          break;
        end++;
      }
      const run = `\x1b[${row + 1};${col + 1}H${sgr}\x1b[${end - col}X`;
      if ((ansi.length + run.length) * 2 > RECOVERY_SNAPSHOT_BYTES) return null;
      ansi += run;
      col = end;
    }
  }
  return ansi;
}

/** Rebuild registers using VT save commands. Private state is read only; unsupported state refuses. */
export function serializeRecoverySavedCursor(terminal: Terminal, ansi: string): string | null {
  const core = (terminal as unknown as { _core: Core })._core;
  const current = attributesSequence(core._inputHandler._curAttrData);
  const charset = charsetSequence(core._charsetService.charsets, core._charsetService.glevel);
  if (current === null || charset === null) return null;
  const save = (buffer: SavedBuffer): string | null => {
    const y = buffer.savedY - buffer.ybase;
    // A fresh renderer already owns this exact default register, including its absolute row
    // above retained history. Do not clamp it to the viewport and change future ESC 8 behavior.
    if (
      buffer.savedY === 0 &&
      buffer.savedX === 0 &&
      buffer.savedCurAttrData.fg === 0 &&
      buffer.savedCurAttrData.bg === 0 &&
      buffer.savedCharsets.length === 0 &&
      buffer.savedGlevel === 0 &&
      !buffer.savedOriginMode &&
      buffer.savedWraparoundMode
    )
      return "";
    if (
      buffer.savedOriginMode ||
      !Number.isInteger(y) ||
      y < 0 ||
      y >= terminal.rows ||
      !Number.isInteger(buffer.savedX) ||
      buffer.savedX < 0 ||
      buffer.savedX >= terminal.cols
    )
      return null;
    const attributes = attributesSequence(buffer.savedCurAttrData);
    const sets = charsetSequence(buffer.savedCharsets, buffer.savedGlevel);
    if (attributes === null || sets === null) return null;
    return `\x1b[?6l\x1b[?7${buffer.savedWraparoundMode ? "h" : "l"}${attributes}${sets}\x1b[${y + 1};${buffer.savedX + 1}H\x1b7`;
  };
  const normal = save(core._bufferService.buffers.normal);
  if (normal === null) return null;
  const normalBlanks = emptyBackgrounds(terminal.buffer.normal, terminal.cols, terminal.rows);
  if (normalBlanks === null) return null;
  if (
    core._bufferService.buffers.normal.savedCharsets.length > core._charsetService.charsets.length
  )
    return null;
  if (terminal.buffer.active.type === "alternate") {
    const alt = save(core._bufferService.buffers.alt);
    const transition = "\x1b[?1049h\x1b[H";
    if (alt === null || !ansi.includes(transition)) return null;
    const altBlanks = emptyBackgrounds(terminal.buffer.alternate, terminal.cols, terminal.rows);
    if (altBlanks === null) return null;
    if (core._bufferService.buffers.alt.savedCharsets.length > core._charsetService.charsets.length)
      return null;
    const normalSets = core._bufferService.buffers.normal.savedCharsets.length;
    if (normalSets > core._bufferService.buffers.alt.savedCharsets.length && alt !== "")
      return null;
    // 1049 would overwrite the just-restored normal register; 47 activates without saving.
    ansi =
      ansi.replace(
        transition,
        normalBlanks + normal + `\x1b[0m${normalSets ? "\x1b(B" : ""}\x0f\x1b[?7h\x1b[?47h\x1b[H`,
      ) +
      altBlanks +
      alt;
  } else ansi += normalBlanks + normal;
  return ansi + current + charset + `\x1b[?7${terminal.modes.wraparoundMode ? "h" : "l"}`;
}
