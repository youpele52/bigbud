import { revealBidiControls } from "@bigbud/shared/String";
import { FileIcon, FolderIcon } from "lucide-react";

import { CommandGroup, CommandItem } from "../ui/command";
import { getFileItemValue, type FileSearchResult } from "./SearchPalette.results";
import { SearchPaletteSectionLabel, SearchPaletteSeeMore } from "./SearchPalette.section";

/** Second line of a file row: the matched line for contents, else where the file lives. */
function describeFileRow(result: FileSearchResult, showLabel: boolean): string {
  if (result.kind === "content") {
    const position = `Line ${result.line ?? 0}${result.column ? `:${result.column}` : ""}`;
    const prefix = showLabel && result.label ? `${result.label} · ` : "";
    return `${prefix}${position} · ${result.excerpt ?? ""}`;
  }
  return showLabel && result.label ? result.label : result.isDirectory ? "Folder" : "File";
}

export function FileSearchResultGroup({
  label,
  results,
  visibleResults,
  showLabel = false,
  onSelect,
  onShowMore,
  renderActions,
}: {
  label: string;
  results: readonly FileSearchResult[];
  visibleResults: readonly FileSearchResult[];
  /** Show the project or folder each row belongs to (other projects, remotes, this computer). */
  showLabel?: boolean;
  onSelect: (result: FileSearchResult) => void;
  onShowMore: () => void;
  /** Secondary actions (for example "Reveal") rendered at the end of a row. */
  renderActions?: (result: FileSearchResult) => React.ReactNode;
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
            {result.isDirectory ? (
              <FolderIcon className="size-4" />
            ) : (
              <FileIcon className="size-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {/* Untrusted names and excerpts: rendered as text, bidi controls made visible. */}
            <div className="truncate text-sm">{revealBidiControls(result.path)}</div>
            <div className="truncate text-muted-foreground text-xs leading-5">
              {revealBidiControls(describeFileRow(result, showLabel))}
            </div>
          </div>
          {renderActions?.(result)}
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
