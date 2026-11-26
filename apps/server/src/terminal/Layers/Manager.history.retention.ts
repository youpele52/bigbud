import { sanitizeTerminalHistoryChunk } from "./Manager.history";
import {
  type BaselineBoundaryScan,
  baselinePreambleAt,
  countNewlines,
  findTerminalHistoryLineCut,
  rebaseBaselineScan,
  scanBaselineBoundaries,
  utf8Length,
} from "./Manager.history.baseline";
import {
  appendRawTerminalSearchText,
  appendTerminalSearchText,
  makeTerminalSearchTail,
  type TerminalSearchTail,
} from "./Manager.history.searchTail";
import type { TerminalSessionState } from "./Manager.types";

export const TERMINAL_HISTORY_BYTE_LIMIT = 1024 * 1024;
export const TERMINAL_HISTORY_CONTROL_BYTE_LIMIT = 16 * 1024;
/** A line cut keeps at most this share of each limit, so trims amortize instead of repeating. */
const TRIM_TARGET_RATIO = 0.75;
/** Room kept for the prepended SGR and modes (well under 1 KiB of ASCII). */
const PREAMBLE_RESERVE_BYTES = 1024;

/** Retention facts derived from `history`; rebuilt from it if the history changes elsewhere. */
export interface TerminalHistoryRetention {
  history: string;
  scan: BaselineBoundaryScan;
  search: TerminalSearchTail;
}

type RetainedSession = Pick<TerminalSessionState, "history" | "historyRetention">;

function retentionState(session: RetainedSession): TerminalHistoryRetention {
  const existing = session.historyRetention;
  if (existing && existing.history === session.history) return existing;
  const scan: BaselineBoundaryScan = { boundary: null, previous: null };
  scanBaselineBoundaries(session.history, 0, scan);
  const state: TerminalHistoryRetention = {
    history: session.history,
    scan,
    search: makeTerminalSearchTail(session.history),
  };
  session.historyRetention = state;
  return state;
}

/** Visible output text (no control sequences), bounded to 512 KiB, for terminal search. */
export function terminalSearchTail(session: RetainedSession): string {
  return retentionState(session).search.text;
}

function surrogatePairSavings(left: string, right: string): number {
  const high = left.charCodeAt(left.length - 1);
  const low = right.charCodeAt(0);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 0;
}

function retainedLines(session: TerminalSessionState, historyNewlines: number): number {
  const pending = session.pendingHistoryControlSequence;
  const last = pending || session.historyTail || "";
  return (
    historyNewlines + countNewlines(pending) + (last.length > 0 && !last.endsWith("\n") ? 1 : 0)
  );
}

/**
 * Bound replay custody as a rolling tail. Over a limit, the history restarts at the newest safe
 * baseline boundary that fits, else at a line boundary outside any open control sequence with
 * the tracked SGR and modes prepended (marked trimmed). An arbitrary VT suffix is never kept:
 * without such a boundary the baseline is discarded (`historyTruncated`).
 */
export function retainTerminalHistory(
  session: TerminalSessionState,
  data: string,
  lineLimit: number,
): boolean {
  const state = retentionState(session);
  if (session.historyTruncated || session.historyUnavailable) {
    appendRawTerminalSearchText(state.search, data);
    return false;
  }
  session.historyBytes ??= utf8Length(session.history);
  session.historyNewlines ??= countNewlines(session.history);
  session.historyTail ??= session.history.slice(-1);
  const limit = Math.max(0, lineLimit);

  const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, data);
  const visible = sanitized.visibleText;
  const pending = sanitized.pendingControlSequence;
  appendTerminalSearchText(state.search, visible);
  const pendingBytes = Buffer.byteLength(pending);
  // An unfinished control that alone exceeds a limit cannot be cut: no baseline survives it.
  if (
    pendingBytes > TERMINAL_HISTORY_CONTROL_BYTE_LIMIT ||
    (pending.length > 0 && countNewlines(pending) + (pending.endsWith("\n") ? 0 : 1) > limit)
  )
    return discardTerminalHistory(session, state);

  scanBaselineBoundaries(visible, session.history.length, state.scan);
  session.historyBytes +=
    Buffer.byteLength(visible) - surrogatePairSavings(session.historyTail, visible);
  session.historyNewlines += countNewlines(visible);
  if (visible.length > 0) session.historyTail = visible.slice(-1);
  session.history += visible;
  session.pendingHistoryControlSequence = pending;
  session.pendingHistoryBytes = pendingBytes;
  state.history = session.history;
  if (
    session.historyBytes + pendingBytes <= TERMINAL_HISTORY_BYTE_LIMIT &&
    retainedLines(session, session.historyNewlines) <= limit
  )
    return visible.length > 0;
  return trimTerminalHistory(session, state, limit);
}

function trimTerminalHistory(
  session: TerminalSessionState,
  state: TerminalHistoryRetention,
  limit: number,
): boolean {
  const history = session.history;
  const historyBytes = session.historyBytes ?? utf8Length(history);
  const historyNewlines = session.historyNewlines ?? countNewlines(history);
  const pendingBytes = session.pendingHistoryBytes ?? 0;
  const fixedLines = retainedLines(session, 0);

  const boundary = state.scan.boundary;
  if (boundary !== null && boundary > 0) {
    const suffixBytes = utf8Length(history, boundary);
    const suffixNewlines = countNewlines(history, boundary);
    if (
      suffixBytes + PREAMBLE_RESERVE_BYTES + pendingBytes <= TERMINAL_HISTORY_BYTE_LIMIT &&
      suffixNewlines + fixedLines <= limit
    ) {
      const preamble = baselinePreambleAt(history, boundary);
      if (preamble !== null) {
        applyHistoryCut(session, state, boundary, preamble, suffixBytes, suffixNewlines);
        session.historyTrimmed = false;
        return true;
      }
    }
  }

  const targetBytes =
    Math.floor(TERMINAL_HISTORY_BYTE_LIMIT * TRIM_TARGET_RATIO) -
    PREAMBLE_RESERVE_BYTES -
    pendingBytes;
  const targetNewlines = Math.max(0, Math.floor(limit * TRIM_TARGET_RATIO) - fixedLines);
  const cut = findTerminalHistoryLineCut(
    history,
    historyBytes - targetBytes,
    historyNewlines - targetNewlines,
  );
  if (cut === null) return discardTerminalHistory(session, state);
  applyHistoryCut(
    session,
    state,
    cut.index,
    cut.preamble,
    historyBytes - cut.droppedBytes,
    historyNewlines - cut.droppedNewlines,
  );
  session.historyTrimmed = true;
  // A cut that cannot meet the line limit (a tiny limit with an unfinished last line) has no
  // replayable baseline either.
  if (retainedLines(session, session.historyNewlines ?? 0) > limit)
    return discardTerminalHistory(session, state);
  return true;
}

function applyHistoryCut(
  session: TerminalSessionState,
  state: TerminalHistoryRetention,
  index: number,
  preamble: string,
  suffixBytes: number,
  suffixNewlines: number,
): void {
  // The preamble is ASCII, so its length is its UTF-8 size.
  session.history = preamble + session.history.slice(index);
  session.historyBytes = preamble.length + suffixBytes;
  session.historyNewlines = suffixNewlines;
  session.historyTail = session.history.slice(-1);
  rebaseBaselineScan(state.scan, index, preamble.length);
  state.history = session.history;
}

function discardTerminalHistory(
  session: TerminalSessionState,
  state: TerminalHistoryRetention,
): boolean {
  session.history = "";
  session.pendingHistoryControlSequence = "";
  session.historyTruncated = true;
  session.historyBytes = 0;
  session.historyNewlines = 0;
  session.historyTail = "";
  session.pendingHistoryBytes = 0;
  state.history = "";
  state.scan = { boundary: null, previous: null };
  session.historyTrimmed = false;
  state.search.carry = "";
  return true;
}
