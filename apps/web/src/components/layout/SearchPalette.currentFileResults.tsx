import { FileIcon } from "lucide-react";

import type { FileSearchMatch } from "./SearchPalette.logic";
import { highlightMatch } from "./SearchPalette.logic";
import { CommandGroup, CommandGroupLabel, CommandItem } from "../ui/command";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar.menu";

interface SearchPaletteCurrentFileResultsProps {
  readonly path: string;
  readonly query: string;
  readonly matches: readonly FileSearchMatch[];
  readonly visibleMatches: readonly FileSearchMatch[];
  readonly onSelect: (line: number) => void;
  readonly onShowMore: () => void;
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

export function SearchPaletteCurrentFileResults({
  path,
  query,
  matches,
  visibleMatches,
  onSelect,
  onShowMore,
}: SearchPaletteCurrentFileResultsProps) {
  const fileName = getFileName(path);

  return (
    <CommandGroup>
      <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
        In {fileName}
      </CommandGroupLabel>
      {matches.length === 0 ? (
        <div className="px-3 py-2 text-muted-foreground text-sm">
          &quot;{query}&quot; wasn&apos;t found in {fileName}.
        </div>
      ) : (
        visibleMatches.map((match) => {
          const highlight = highlightMatch(match.lineText, query);
          return (
            <CommandItem
              key={`${path}:${match.line}`}
              value={`${path} ${match.lineText}`.toLowerCase()}
              className="min-h-11 rounded-xl px-3 py-2"
              onSelect={() => onSelect(match.line)}
              onClick={() => onSelect(match.line)}
            >
              <div className="mr-3 text-muted-foreground/70">
                <FileIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">Line {match.line}</div>
                <div className="truncate text-muted-foreground text-xs leading-5">
                  {highlight.hasMatch ? (
                    <>
                      {highlight.before}
                      <mark className="rounded-sm bg-primary/20 px-0.5 font-medium text-foreground">
                        {highlight.match}
                      </mark>
                      {highlight.after}
                    </>
                  ) : (
                    match.lineText
                  )}
                </div>
              </div>
            </CommandItem>
          );
        })
      )}
      {matches.length > visibleMatches.length ? (
        <SidebarMenuSubItem className="w-full px-2 pt-1">
          <SidebarMenuSubButton
            render={<button type="button" />}
            size="sm"
            className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
            onClick={onShowMore}
          >
            <span>{`See more (${matches.length - visibleMatches.length})`}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </CommandGroup>
  );
}
