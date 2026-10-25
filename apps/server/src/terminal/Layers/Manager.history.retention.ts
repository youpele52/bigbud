import { sanitizeTerminalHistoryChunk } from "./Manager.history";
import type { TerminalSessionState } from "./Manager.types";

export const TERMINAL_HISTORY_BYTE_LIMIT = 1024 * 1024;
export const TERMINAL_HISTORY_CONTROL_BYTE_LIMIT = 16 * 1024;

function newlines(value: string): number {
  let count = 0;
  for (let i = value.indexOf("\n"); i !== -1; i = value.indexOf("\n", i + 1)) count++;
  return count;
}

function surrogatePairSavings(left: string, right: string): number {
  const high = left.charCodeAt(left.length - 1);
  const low = right.charCodeAt(0);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 0;
}

/** Bound replay custody without ever treating an arbitrary VT suffix as a checkpoint. */
export function retainTerminalHistory(
  session: TerminalSessionState,
  data: string,
  lineLimit: number,
): boolean {
  if (session.historyTruncated || session.historyUnavailable) return false;
  session.historyBytes ??= Buffer.byteLength(session.history);
  session.historyNewlines ??= newlines(session.history);
  session.historyTail ??= session.history.slice(-1);
  session.pendingHistoryBytes ??= Buffer.byteLength(session.pendingHistoryControlSequence);
  const discard = () => {
    session.history = "";
    session.pendingHistoryControlSequence = "";
    session.historyTruncated = true;
    session.historyBytes = 0;
    session.historyNewlines = 0;
    session.historyTail = "";
    session.pendingHistoryBytes = 0;
    return true;
  };
  // Check before concatenating/parsing: a single unterminated OSC/DCS or redraw
  // must not accumulate unbounded carry. Live PTY delivery remains untouched.
  if (
    session.historyBytes +
      session.pendingHistoryBytes +
      Buffer.byteLength(data) -
      surrogatePairSavings(session.pendingHistoryControlSequence || session.historyTail, data) >
    TERMINAL_HISTORY_BYTE_LIMIT
  )
    return discard();

  const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, data);
  const historyNewlines = session.historyNewlines + newlines(sanitized.visibleText);
  const last = sanitized.pendingControlSequence || sanitized.visibleText || session.historyTail;
  const historyLines =
    historyNewlines +
    newlines(sanitized.pendingControlSequence) +
    (last.length > 0 && !last.endsWith("\n") ? 1 : 0);
  const pendingBytes = Buffer.byteLength(sanitized.pendingControlSequence);
  if (pendingBytes > TERMINAL_HISTORY_CONTROL_BYTE_LIMIT || historyLines > Math.max(0, lineLimit))
    return discard();

  session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
  session.pendingHistoryBytes = pendingBytes;
  session.historyBytes +=
    Buffer.byteLength(sanitized.visibleText) -
    surrogatePairSavings(session.historyTail, sanitized.visibleText);
  session.historyNewlines = historyNewlines;
  if (sanitized.visibleText.length > 0) session.historyTail = sanitized.visibleText.slice(-1);
  session.history += sanitized.visibleText;
  return sanitized.visibleText.length > 0;
}
