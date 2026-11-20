import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  TerminalInlineBar,
  TerminalInlineBarButton,
  TerminalInlineBarInput,
} from "./TerminalInlineBar";
import {
  EMPTY_FIND_RESULTS,
  formatTerminalFindResults,
  revealTerminalFindSeed,
  safeTerminalFind,
  terminalFindOptions,
} from "./TerminalFindBar.logic";
import type { TerminalFindSeed, TerminalFindState } from "./TerminalViewport.viewState";

function ToggleButton(props: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <TerminalInlineBarButton
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      data-pressed={props.pressed ? "" : undefined}
      onClick={props.onToggle}
    >
      {props.children}
    </TerminalInlineBarButton>
  );
}

/**
 * Find in the terminal's buffer and scrollback: mod+f while the terminal is focused, or a
 * terminal hit in global search (which arrives as a seed). The field is the app's standard Input.
 */
export function TerminalFindBar({ find }: { find: TerminalFindState }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seedRef = useRef<TerminalFindSeed | null>(null);
  const [query, setQuery] = useState(find.seed?.query ?? "");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState(EMPTY_FIND_RESULTS);
  const flags = { caseSensitive, regex };

  useEffect(() => {
    void find.requestId;
    if (find.seed) {
      seedRef.current = find.seed;
      setQuery(find.seed.query);
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [find.requestId, find.seed]);

  useEffect(() => {
    const subscription = find.search()?.onDidChangeResults((next) => setResults(next));
    return () => subscription?.dispose();
  }, [find]);

  useEffect(() => {
    const search = find.search();
    if (!search) return;
    if (!query) {
      search.clearDecorations();
      setResults(EMPTY_FIND_RESULTS);
      return;
    }
    const seed = seedRef.current;
    const terminal = find.terminal();
    if (seed && seed.query === query && terminal) {
      seedRef.current = null;
      revealTerminalFindSeed(
        terminal,
        search,
        query,
        terminalFindOptions({ caseSensitive, regex }),
        seed.lineText,
      );
      return;
    }
    safeTerminalFind(search, "next", query, terminalFindOptions({ caseSensitive, regex }, true));
  }, [find, query, caseSensitive, regex]);

  const step = (direction: "next" | "previous") => {
    const search = find.search();
    if (search) safeTerminalFind(search, direction, query, terminalFindOptions(flags));
  };

  return (
    <TerminalInlineBar
      className="absolute top-2 left-1/2 z-20 max-w-[calc(100%-1.5rem)] -translate-x-1/2"
      role="search"
    >
      <TerminalInlineBarInput
        ref={inputRef}
        aria-label="Find in terminal"
        placeholder="Find"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            find.close();
          } else if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? "previous" : "next");
          }
        }}
      />
      <span
        className="min-w-16 shrink-0 px-1 text-right text-muted-foreground text-xs"
        aria-live="polite"
      >
        {formatTerminalFindResults(query, results)}
      </span>
      <ToggleButton
        label="Match case"
        pressed={caseSensitive}
        onToggle={() => setCaseSensitive((value) => !value)}
      >
        <CaseSensitive />
      </ToggleButton>
      <ToggleButton
        label="Use regular expression"
        pressed={regex}
        onToggle={() => setRegex((value) => !value)}
      >
        <Regex />
      </ToggleButton>
      <TerminalInlineBarButton
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        onClick={() => step("previous")}
      >
        <ChevronUp />
      </TerminalInlineBarButton>
      <TerminalInlineBarButton
        aria-label="Next match"
        title="Next match (Enter)"
        onClick={() => step("next")}
      >
        <ChevronDown />
      </TerminalInlineBarButton>
      <TerminalInlineBarButton aria-label="Close find" title="Close (Esc)" onClick={find.close}>
        <X />
      </TerminalInlineBarButton>
    </TerminalInlineBar>
  );
}
