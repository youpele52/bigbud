import type { MessageId, ThreadId } from "@bigbud/contracts";
import { Comment03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { highlightMatch } from "./SearchPalette.logic";
import type { MessageSearchResult } from "./SearchPalette.results";
import { SearchPaletteSectionLabel, SearchPaletteSeeMore } from "./SearchPalette.section";
import { CommandGroup, CommandItem } from "../ui/command";

interface Props {
  label: string;
  query: string;
  results: MessageSearchResult[];
  visibleResults: MessageSearchResult[];
  /** Messages outside the current thread show "project > thread". */
  showLocation: boolean;
  /** More server pages exist beyond `results`. */
  hasMorePages?: boolean;
  onSelect: (threadId: ThreadId, messageId: MessageId) => void;
  onShowMore: () => void;
}

function MessageItem({
  result,
  query,
  onSelect,
  showLocation,
}: {
  result: MessageSearchResult;
  query: string;
  onSelect: Props["onSelect"];
  showLocation: boolean;
}) {
  const highlight = highlightMatch(result.snippet, query);
  return (
    <CommandItem
      value={`${result.text} ${result.snippet}`.toLowerCase()}
      className="min-h-11 rounded-xl px-3 py-2"
      onSelect={() => onSelect(result.threadId, result.messageId)}
      onClick={() => onSelect(result.threadId, result.messageId)}
    >
      <div className="mr-3 text-muted-foreground/70">
        <HugeiconsIcon
          aria-hidden="true"
          className="size-4"
          icon={Comment03Icon}
          strokeWidth={1.5}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-muted-foreground text-sm leading-6">
          {highlight.hasMatch ? (
            <>
              {highlight.before}
              <mark className="rounded-sm bg-primary/20 px-0.5 font-medium text-foreground">
                {highlight.match}
              </mark>
              {highlight.after}
            </>
          ) : (
            result.snippet
          )}
        </div>
        {showLocation && (
          <div className="truncate text-muted-foreground text-xs leading-5">
            {result.projectName} &gt; {result.threadTitle}
          </div>
        )}
      </div>
    </CommandItem>
  );
}

export function SearchPaletteMessageResults({
  label,
  query,
  results,
  visibleResults,
  showLocation,
  hasMorePages = false,
  onSelect,
  onShowMore,
}: Props) {
  if (results.length === 0 && !hasMorePages) return null;
  const remaining = results.length - visibleResults.length;
  return (
    <CommandGroup className="mt-2 first:mt-0">
      <SearchPaletteSectionLabel>{label}</SearchPaletteSectionLabel>
      {visibleResults.map((result) => (
        <MessageItem
          key={result.id}
          result={result}
          query={query}
          onSelect={onSelect}
          showLocation={showLocation}
        />
      ))}
      {remaining > 0 || hasMorePages ? (
        <SearchPaletteSeeMore
          indent
          remaining={hasMorePages ? undefined : remaining}
          onClick={onShowMore}
        />
      ) : null}
    </CommandGroup>
  );
}
