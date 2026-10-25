// Adapted from Orca (stablyai/orca, MIT) TerminalSearch.tsx and terminal-search-safe-find.ts at
// be4e0719.
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

/** xterm reports index -1 when matches exceed its highlight limit. */
export const EMPTY_FIND_RESULTS = { resultIndex: -1, resultCount: 0 };

/** xterm needs hex colours; explicit highlights stay visible over every terminal theme. */
export function terminalFindOptions(
  input: { caseSensitive: boolean; regex: boolean },
  incremental = false,
): ISearchOptions {
  return {
    caseSensitive: input.caseSensitive,
    regex: input.regex,
    incremental,
    decorations: {
      matchBackground: "#5c4a00",
      matchBorder: "#5c4a00",
      matchOverviewRuler: "#ffcc00",
      activeMatchBackground: "#c4580e",
      activeMatchBorder: "#ffcf6b",
      activeMatchColorOverviewRuler: "#ff9900",
    },
  };
}

/**
 * A match starting beyond the live column count makes xterm's decoration width negative and
 * `registerDecoration` throws synchronously; navigation already happened, so drop the highlight
 * for that frame instead of taking the terminal down. An invalid regex finds nothing.
 */
export function safeTerminalFind(
  search: SearchAddon,
  direction: "next" | "previous",
  term: string,
  options: ISearchOptions,
): boolean {
  if (!term) return false;
  try {
    return direction === "next"
      ? search.findNext(term, options)
      : search.findPrevious(term, options);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    if (error instanceof Error && /only accepts positive integers/i.test(error.message))
      return false;
    throw error;
  }
}

export function formatTerminalFindResults(
  query: string,
  results: { resultIndex: number; resultCount: number },
): string {
  if (!query) return "";
  if (results.resultCount === 0) return "No results";
  if (results.resultIndex < 0) return `${results.resultCount}+ matches`;
  return `${results.resultIndex + 1} of ${results.resultCount}`;
}

/** Upper bound on matches stepped through while revealing a global search hit. */
export const TERMINAL_FIND_REVEAL_MAX_STEPS = 200;

type RevealTerminal = Pick<Terminal, "getSelectionPosition"> & {
  readonly buffer: { readonly active: Pick<Terminal["buffer"]["active"], "getLine"> };
};

/** The full logical (unwrapped) line containing buffer row `row`. */
export function terminalLogicalLineAt(terminal: RevealTerminal, row: number): string {
  const buffer = terminal.buffer.active;
  let start = row;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let text = buffer.getLine(start)?.translateToString(true) ?? "";
  for (let next = start + 1; buffer.getLine(next)?.isWrapped; next++)
    text += buffer.getLine(next)?.translateToString(true) ?? "";
  return text;
}

/**
 * Step backwards from the newest output to the match on `lineText` (the hit's line as the server
 * displayed it, possibly clipped with "…"). Ends on the newest match when the line is not found,
 * e.g. when the view's scrollback no longer holds it.
 */
export function revealTerminalFindSeed(
  terminal: RevealTerminal,
  search: SearchAddon,
  query: string,
  options: ISearchOptions,
  lineText: string,
): boolean {
  const target = lineText
    .replace(/^…|…$/g, "")
    .trim()
    .toLowerCase();
  let first: string | null = null;
  for (let step = 0; step < TERMINAL_FIND_REVEAL_MAX_STEPS; step++) {
    if (!safeTerminalFind(search, "previous", query, options)) return false;
    const position = terminal.getSelectionPosition();
    if (!position) return false;
    const key = `${position.start.y}:${position.start.x}`;
    // Back at the first (newest) match: every match was visited.
    if (key === first) return false;
    first ??= key;
    if (!target || terminalLogicalLineAt(terminal, position.start.y).toLowerCase().includes(target))
      return true;
  }
  return false;
}
