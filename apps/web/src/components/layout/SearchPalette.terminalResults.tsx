import type { ThreadId } from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";
import { SquareTerminalIcon } from "lucide-react";
import { useMemo } from "react";

import { terminalSearchQueryOptions } from "~/lib/terminalSearchQuery";
import { useTerminalStateStore } from "../../stores/terminal";
import { CommandGroup, CommandGroupLabel, CommandItem } from "../ui/command";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar.menu";
import { highlightMatch } from "./SearchPalette.logic";
import {
  toTerminalSearchResults,
  type TerminalSearchResult,
} from "./SearchPalette.terminalResults.logic";

/**
 * Terminal output hits for the palette query. Hits from threads the palette does not list
 * (archived, being deleted, hidden) are dropped.
 */
export function useTerminalSearchResults(input: {
  readonly query: string;
  readonly enabled: boolean;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly deletingAt?: string | null | undefined;
  }>;
}) {
  const search = useQuery(
    terminalSearchQueryOptions({ query: input.query, enabled: input.enabled }),
  );
  const { threads } = input;
  const results = useMemo(() => {
    if (search.isError || !search.data) return [];
    const titles = new Map(
      threads
        .filter((thread) => thread.archivedAt === null && !thread.deletingAt)
        .map((thread) => [thread.id, thread.title] as const),
    );
    return toTerminalSearchResults(search.data.hits, {
      threadTitle: (threadId) => titles.get(threadId) ?? null,
      store: useTerminalStateStore.getState(),
    });
  }, [search.data, search.isError, threads]);
  return { results, isPending: search.isFetching };
}

interface TerminalSearchResultGroupProps {
  query: string;
  results: TerminalSearchResult[];
  visibleResults: TerminalSearchResult[];
  onSelect: (result: TerminalSearchResult) => void;
  onShowMore: () => void;
}

export function TerminalSearchResultGroup({
  query,
  results,
  visibleResults,
  onSelect,
  onShowMore,
}: TerminalSearchResultGroupProps) {
  if (results.length === 0) return null;

  return (
    <CommandGroup className="mt-2">
      <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
        Terminals
      </CommandGroupLabel>
      {visibleResults.map((result) => {
        const highlight = highlightMatch(result.lineText, query.trim());
        return (
          <CommandItem
            key={result.id}
            value={`${result.terminalLabel} ${result.threadTitle} ${result.lineText}`.toLowerCase()}
            className="min-h-11 rounded-xl px-3 py-2"
            onSelect={() => onSelect(result)}
            onClick={() => onSelect(result)}
          >
            <div className="mr-3 text-muted-foreground/70">
              <SquareTerminalIcon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs leading-5">
                {highlight.hasMatch ? (
                  <>
                    {highlight.before}
                    <mark className="rounded-sm bg-primary/20 px-0.5 font-medium text-foreground">
                      {highlight.match}
                    </mark>
                    {highlight.after}
                  </>
                ) : (
                  result.lineText
                )}
              </div>
              <div className="truncate text-muted-foreground text-xs leading-5">
                {result.threadTitle} &gt; {result.terminalLabel}
                {result.running ? "" : " (exited)"}
              </div>
            </div>
          </CommandItem>
        );
      })}
      {results.length > visibleResults.length ? (
        <SidebarMenuSubItem className="w-full px-2 pt-1">
          <SidebarMenuSubButton
            render={<button type="button" />}
            size="sm"
            className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
            onClick={onShowMore}
          >
            <span>{`See more (${results.length - visibleResults.length})`}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </CommandGroup>
  );
}
