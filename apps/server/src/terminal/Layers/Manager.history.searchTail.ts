import { stripTerminalControlSequences } from "@bigbud/shared/terminalText";
import { sanitizeTerminalHistoryChunk } from "./Manager.history";
import { utf8Length } from "./Manager.history.baseline";

/** Visible text kept per terminal for search, independent of the replay baseline. */
export const TERMINAL_SEARCH_TAIL_BYTE_LIMIT = 512 * 1024;
/** Trim to this so the tail is not re-cut on every chunk once it is full. */
const TERMINAL_SEARCH_TAIL_TRIM_TARGET = 384 * 1024;
const SEARCH_CARRY_CHAR_LIMIT = 16 * 1024;

export interface TerminalSearchTail {
  text: string;
  bytes: number;
  /** Unfinished control carry, used only while the replay history is not retained. */
  carry: string;
}

export function makeTerminalSearchTail(history: string): TerminalSearchTail {
  const tail: TerminalSearchTail = { text: "", bytes: 0, carry: "" };
  appendTerminalSearchText(tail, history);
  return tail;
}

/** Appends sanitized output (complete controls only), keeping ≤ 512 KiB of visible text. */
export function appendTerminalSearchText(tail: TerminalSearchTail, sanitized: string): void {
  if (sanitized.length === 0) return;
  const plain = stripTerminalControlSequences(sanitized);
  if (plain.length === 0) return;
  tail.text += plain;
  tail.bytes += Buffer.byteLength(plain);
  if (tail.bytes > TERMINAL_SEARCH_TAIL_BYTE_LIMIT) trimTerminalSearchTail(tail);
}

/** Raw output while no replay history is retained: carry split controls out of the text. */
export function appendRawTerminalSearchText(tail: TerminalSearchTail, data: string): void {
  const sanitized = sanitizeTerminalHistoryChunk(tail.carry, data);
  tail.carry =
    sanitized.pendingControlSequence.length > SEARCH_CARRY_CHAR_LIMIT
      ? ""
      : sanitized.pendingControlSequence;
  appendTerminalSearchText(tail, sanitized.visibleText);
}

/** Drops whole leading lines; a single over-long line is cut at a code-point boundary. */
function trimTerminalSearchTail(tail: TerminalSearchTail): void {
  const text = tail.text;
  const minimum = tail.bytes - TERMINAL_SEARCH_TAIL_TRIM_TARGET;
  let index = 0;
  let dropped = 0;
  while (index < text.length && dropped < minimum) {
    const code = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      dropped += 4;
      index += 2;
    } else {
      dropped += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      index++;
    }
  }
  const newline = text.charCodeAt(index - 1) === 0x0a ? index - 1 : text.indexOf("\n", index);
  if (newline !== -1 && newline + 1 < text.length) {
    dropped += utf8Length(text, index, newline + 1);
    index = newline + 1;
  }
  tail.text = text.slice(index);
  tail.bytes -= dropped;
}
