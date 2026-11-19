import { FileIcon } from "lucide-react";

import { CommandGroup, CommandItem } from "../ui/command";
import { getFileItemValue, type FileSearchResult } from "./SearchPalette.results";
import { SearchPaletteSectionLabel, SearchPaletteSeeMore } from "./SearchPalette.section";

export function FileSearchResultGroup({
  label,
  results,
  visibleResults,
  onSelect,
  onShowMore,
}: {
  label: string;
  results: FileSearchResult[];
  visibleResults: FileSearchResult[];
  onSelect: (result: FileSearchResult) => void;
  onShowMore: () => void;
}) {
  if (results.length === 0) return null;
  return (
    <CommandGroup className="mt-2 first:mt-0">
      <SearchPaletteSectionLabel>{label}</SearchPaletteSectionLabel>
      {visibleResults.map((result) => (
        <CommandItem
          key={result.id}
          value={getFileItemValue(result)}
          className="min-h-11 rounded-xl px-3 py-2"
          onSelect={() => onSelect(result)}
          onClick={() => onSelect(result)}
        >
          <div className="mr-3 text-muted-foreground/70">
            <FileIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{result.path}</div>
            <div className="truncate text-muted-foreground text-xs leading-5">
              Line {result.line}
              {result.column ? `:${result.column}` : ""} · {result.lineText}
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
