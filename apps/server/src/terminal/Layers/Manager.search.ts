import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import {
  TERMINAL_SEARCH_DEFAULT_LIMIT,
  TERMINAL_SEARCH_MAX_LIMIT,
  TERMINAL_SEARCH_MAX_QUERY_LENGTH,
  TERMINAL_SEARCH_MIN_QUERY_LENGTH,
  type TerminalSearchHit,
  type TerminalSearchInput,
  type TerminalSearchResult,
} from "@bigbud/contracts/workspace/terminal.search.ts";
import { terminalOutputLines } from "@bigbud/shared/terminalText";

/** Long lines are clipped to a window around the match. */
const LINE_CONTEXT_BEFORE = 80;
const LINE_CONTEXT_AFTER = 160;

export interface SearchableTerminal {
  readonly threadId: string;
  readonly terminalId: string;
  readonly status: string;
  readonly history: string;
  readonly updatedAt: string;
}

interface CachedLines {
  readonly history: string;
  readonly lines: readonly string[];
  readonly lowered: readonly string[];
}

/**
 * Scan-on-search over the output each terminal already retains (bounded per terminal by the
 * history limits), so the output path pays nothing. Displayed lines are cached per terminal and
 * rebuilt only when that terminal's history changed since the previous search.
 */
export class TerminalSearchIndex {
  private readonly cache = new Map<string, CachedLines>();

  search(
    sessions: readonly SearchableTerminal[],
    input: TerminalSearchInput,
  ): TerminalSearchResult {
    const query = input.query.trim().toLowerCase();
    const length = [...query].length;
    if (length < TERMINAL_SEARCH_MIN_QUERY_LENGTH || length > TERMINAL_SEARCH_MAX_QUERY_LENGTH)
      return { hits: [], truncated: false };
    const limit = Math.min(input.limit ?? TERMINAL_SEARCH_DEFAULT_LIMIT, TERMINAL_SEARCH_MAX_LIMIT);
    this.forgetMissing(sessions);
    // Running terminals first, then the most recently active.
    const ordered = [...sessions].toSorted(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    const hits: TerminalSearchHit[] = [];
    let truncated = false;
    for (const session of ordered) {
      const { lines, lowered } = this.linesFor(session);
      const seen = new Set<string>();
      for (let index = lines.length - 1; index >= 0; index--) {
        const matchStart = lowered[index]!.indexOf(query);
        if (matchStart === -1) continue;
        const line = lines[index]!;
        // Spinners and redraws repeat a line; keep only its newest occurrence.
        if (seen.has(line)) continue;
        seen.add(line);
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
        hits.push({
          threadId: ThreadId.makeUnsafe(session.threadId),
          terminalId: session.terminalId,
          // Lower-casing can change the length of a few characters; never point past the line.
          ...clipLine(line, Math.min(matchStart, line.length), query.length),
          linesFromEnd: lines.length - 1 - index,
          running: session.status === "running",
        });
      }
      if (truncated) break;
    }
    return { hits, truncated };
  }

  private linesFor(session: SearchableTerminal): CachedLines {
    const key = cacheKey(session);
    const cached = this.cache.get(key);
    if (cached && cached.history === session.history) return cached;
    const lines = terminalOutputLines(session.history);
    const next = {
      history: session.history,
      lines,
      lowered: lines.map((line) => line.toLowerCase()),
    };
    this.cache.set(key, next);
    return next;
  }

  /** Closed or evicted terminals must not keep their text alive in the cache. */
  private forgetMissing(sessions: readonly SearchableTerminal[]): void {
    const live = new Set(sessions.map(cacheKey));
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);
  }
}

function cacheKey(session: Pick<SearchableTerminal, "threadId" | "terminalId">): string {
  return JSON.stringify([session.threadId, session.terminalId]);
}

function clipLine(
  line: string,
  matchStart: number,
  matchLength: number,
): { lineText: string; matchStart: number } {
  if (line.length <= LINE_CONTEXT_BEFORE + LINE_CONTEXT_AFTER)
    return { lineText: line, matchStart };
  const start = Math.max(0, matchStart - LINE_CONTEXT_BEFORE);
  const end = Math.min(line.length, matchStart + matchLength + LINE_CONTEXT_AFTER);
  const prefix = start > 0 ? "…" : "";
  return {
    lineText: `${prefix}${line.slice(start, end)}${end < line.length ? "…" : ""}`,
    matchStart: matchStart - start + prefix.length,
  };
}
