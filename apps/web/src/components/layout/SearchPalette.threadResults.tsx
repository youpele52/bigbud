import type { ThreadId } from "@bigbud/contracts";
import { Comment03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { CommandGroup, CommandItem } from "../ui/command";
import { getThreadItemValue, type ThreadSearchResult } from "./SearchPalette.results";
import { SearchPaletteSectionLabel, SearchPaletteSeeMore } from "./SearchPalette.section";

export function ThreadSearchResultGroup({
  label,
  results,
  visibleResults,
  onSelect,
  onShowMore,
}: {
  label: string;
  results: ThreadSearchResult[];
  visibleResults: ThreadSearchResult[];
  onSelect: (threadId: ThreadId) => void;
  onShowMore: () => void;
}) {
  if (results.length === 0) return null;
  return (
    <CommandGroup className="mt-2 first:mt-0">
      <SearchPaletteSectionLabel>{label}</SearchPaletteSectionLabel>
      {visibleResults.map((result) => (
        <CommandItem
          key={result.id}
          value={getThreadItemValue(result)}
          className="min-h-11 rounded-xl px-3 py-2"
          onSelect={() => onSelect(result.threadId)}
          onClick={() => onSelect(result.threadId)}
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
            <div className="truncate text-sm">{result.title}</div>
            <div className="truncate text-muted-foreground text-xs leading-5">
              {result.projectName} &gt; {result.title}
            </div>
          </div>
        </CommandItem>
      ))}
      {results.length > visibleResults.length ? (
        <SearchPaletteSeeMore
          remaining={results.length - visibleResults.length}
          onClick={onShowMore}
        />
      ) : null}
    </CommandGroup>
  );
}
