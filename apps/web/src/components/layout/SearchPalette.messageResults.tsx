import type { MessageId, ThreadId } from "@bigbud/contracts";
import { MessageSquareIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { highlightMatch } from "./SearchPalette.logic";
import type { MessageSearchResult } from "./SearchPalette.results";
import { CommandGroup, CommandGroupLabel, CommandItem } from "../ui/command";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar.menu";

interface Props {
  query: string;
  inThreadResults: MessageSearchResult[];
  otherThreadResults: MessageSearchResult[];
  visibleOtherThreadResults: MessageSearchResult[];
  hasMorePages: boolean;
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
        <MessageSquareIcon className="size-4" />
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
  query,
  inThreadResults,
  otherThreadResults,
  visibleOtherThreadResults,
  hasMorePages,
  onSelect,
  onShowMore,
}: Props) {
  const hasMore = otherThreadResults.length > visibleOtherThreadResults.length || hasMorePages;
  return (
    <>
      {inThreadResults.length > 0 && (
        <CommandGroup>
          <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
            In this thread
          </CommandGroupLabel>
          {inThreadResults.map((result) => (
            <MessageItem
              key={result.id}
              result={result}
              query={query}
              onSelect={onSelect}
              showLocation={false}
            />
          ))}
        </CommandGroup>
      )}
      {(otherThreadResults.length > 0 || hasMorePages) && (
        <CommandGroup className={cn(inThreadResults.length > 0 ? "mt-2" : undefined)}>
          <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
            Messages in other threads
          </CommandGroupLabel>
          {visibleOtherThreadResults.map((result) => (
            <MessageItem
              key={result.id}
              result={result}
              query={query}
              onSelect={onSelect}
              showLocation
            />
          ))}
          {hasMore && (
            <SidebarMenuSubItem className="w-full px-2 pt-1 pl-9">
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={onShowMore}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span>
                    {hasMorePages
                      ? "See more"
                      : `See more (${otherThreadResults.length - visibleOtherThreadResults.length})`}
                  </span>
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </CommandGroup>
      )}
    </>
  );
}
