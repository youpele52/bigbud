import { type MessageId, type ProjectFileContentMatch, type ThreadId } from "@bigbud/contracts";
import { FileIcon, MessageSquareIcon } from "lucide-react";

import { highlightMatch } from "./SearchPalette.logic";
import { CommandGroup, CommandGroupLabel, CommandItem } from "../ui/command";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar.menu";
import { cn } from "~/lib/utils";

export interface ThreadSearchResult {
  id: string;
  threadId: ThreadId;
  title: string;
  projectName: string;
  matchedMessageText: string;
  type: "thread";
}

export interface MessageSearchResult {
  id: string;
  threadId: ThreadId;
  messageId: MessageId;
  threadTitle: string;
  projectName: string;
  text: string;
  snippet: string;
  matchIndex: number;
  type: "message";
}

export interface FileSearchResult {
  id: string;
  path: string;
  line: number;
  column: number | null;
  lineText: string;
  type: "file";
}

export function getMessageItemValue(result: MessageSearchResult): string {
  return `${result.text} ${result.snippet}`.toLowerCase();
}

export function getThreadItemValue(result: ThreadSearchResult): string {
  return `${result.title} ${result.projectName} ${result.matchedMessageText}`.toLowerCase();
}

export function getFileItemValue(result: FileSearchResult): string {
  return `${result.path} ${result.lineText}`.toLowerCase();
}

export function toFileSearchResults(
  matches: readonly ProjectFileContentMatch[],
): FileSearchResult[] {
  return matches.map((match) => ({
    id: `file:${match.path}:${match.line}:${match.column ?? 0}`,
    path: match.path,
    line: match.line,
    column: match.column ?? null,
    lineText: match.lineText,
    type: "file",
  }));
}

interface SearchPaletteResultsProps {
  query: string;
  normalizedQuery: string;
  isSearchPending: boolean;
  isFileSearchPending: boolean;
  inThreadMessageResults: MessageSearchResult[];
  otherThreadMessageResults: MessageSearchResult[];
  visibleOtherThreadMessageResults: MessageSearchResult[];
  visibleOtherMessageCount: number;
  setVisibleOtherMessageCount: React.Dispatch<React.SetStateAction<number>>;
  threadResults: ThreadSearchResult[];
  visibleThreadResults: ThreadSearchResult[];
  setVisibleThreadCount: React.Dispatch<React.SetStateAction<number>>;
  fileResults: FileSearchResult[];
  visibleFileResults: FileSearchResult[];
  setVisibleFileCount: React.Dispatch<React.SetStateAction<number>>;
  hasMessageResults: boolean;
  hasThreadResults: boolean;
  hasFileResults: boolean;
  onSelectMessage: (threadId: ThreadId, messageId: MessageId) => void;
  onSelectThread: (threadId: ThreadId) => void;
  onSelectFile: (result: FileSearchResult) => void;
  initialVisibleResultCount: number;
}

export function SearchPaletteResults({
  query,
  normalizedQuery,
  isSearchPending,
  isFileSearchPending,
  inThreadMessageResults,
  otherThreadMessageResults,
  visibleOtherThreadMessageResults,
  setVisibleOtherMessageCount,
  threadResults,
  visibleThreadResults,
  setVisibleThreadCount,
  fileResults,
  visibleFileResults,
  setVisibleFileCount,
  hasMessageResults,
  hasThreadResults,
  hasFileResults,
  onSelectMessage,
  onSelectThread,
  onSelectFile,
  initialVisibleResultCount,
}: SearchPaletteResultsProps) {
  const hasResults = hasMessageResults || hasThreadResults || hasFileResults;

  return (
    <>
      {(isSearchPending || isFileSearchPending) && normalizedQuery && (
        <div className="px-4 py-8 text-center text-muted-foreground text-sm">Searching...</div>
      )}

      {!isSearchPending && !isFileSearchPending && !hasResults && normalizedQuery && (
        <div className="px-4 py-8 text-center text-muted-foreground text-sm">
          No matching results
        </div>
      )}

      {!isSearchPending && inThreadMessageResults.length > 0 && (
        <CommandGroup>
          <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
            In this thread
          </CommandGroupLabel>
          {inThreadMessageResults.map((result) => (
            <CommandItem
              key={result.id}
              value={getMessageItemValue(result)}
              className="min-h-11 rounded-xl px-3 py-2"
              onSelect={() => onSelectMessage(result.threadId, result.messageId)}
              onClick={() => onSelectMessage(result.threadId, result.messageId)}
            >
              <div className="mr-3 text-muted-foreground/70">
                <MessageSquareIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-muted-foreground text-sm leading-6">
                  {(() => {
                    const highlight = highlightMatch(result.snippet, query);
                    return highlight.hasMatch ? (
                      <>
                        {highlight.before}
                        <mark className="rounded-sm bg-primary/20 px-0.5 font-medium text-foreground">
                          {highlight.match}
                        </mark>
                        {highlight.after}
                      </>
                    ) : (
                      result.snippet
                    );
                  })()}
                </div>
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      )}

      {!isSearchPending && otherThreadMessageResults.length > 0 && (
        <CommandGroup className={cn(inThreadMessageResults.length > 0 ? "mt-2" : undefined)}>
          <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
            Messages in other threads
          </CommandGroupLabel>
          {visibleOtherThreadMessageResults.map((result) => (
            <CommandItem
              key={result.id}
              value={getMessageItemValue(result)}
              className="min-h-11 rounded-xl px-3 py-2"
              onSelect={() => onSelectMessage(result.threadId, result.messageId)}
              onClick={() => onSelectMessage(result.threadId, result.messageId)}
            >
              <div className="mr-3 text-muted-foreground/70">
                <MessageSquareIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-muted-foreground text-sm leading-6">
                  {(() => {
                    const highlight = highlightMatch(result.snippet, query);
                    return highlight.hasMatch ? (
                      <>
                        {highlight.before}
                        <mark className="rounded-sm bg-primary/20 px-0.5 font-medium text-foreground">
                          {highlight.match}
                        </mark>
                        {highlight.after}
                      </>
                    ) : (
                      result.snippet
                    );
                  })()}
                </div>
                <div className="truncate text-muted-foreground text-xs leading-5">
                  {result.projectName} &gt; {result.threadTitle}
                </div>
              </div>
            </CommandItem>
          ))}
          {otherThreadMessageResults.length > visibleOtherThreadMessageResults.length ? (
            <SidebarMenuSubItem className="w-full px-2 pt-1 pl-9">
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() =>
                  setVisibleOtherMessageCount((current) => current + initialVisibleResultCount)
                }
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span>{`See more (${otherThreadMessageResults.length - visibleOtherThreadMessageResults.length})`}</span>
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </CommandGroup>
      )}

      {!isSearchPending && hasThreadResults && (
        <CommandGroup className={cn(hasMessageResults ? "mt-2" : undefined)}>
          <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
            All threads
          </CommandGroupLabel>
          {visibleThreadResults.map((result) => (
            <CommandItem
              key={result.id}
              value={getThreadItemValue(result)}
              className="min-h-11 rounded-xl px-3 py-2"
              onSelect={() => onSelectThread(result.threadId)}
              onClick={() => onSelectThread(result.threadId)}
            >
              <div className="mr-3 text-muted-foreground/70">
                <MessageSquareIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{result.title}</div>
                <div className="truncate text-muted-foreground text-xs leading-5">
                  {result.projectName} &gt; {result.title}
                </div>
              </div>
            </CommandItem>
          ))}
          {threadResults.length > visibleThreadResults.length ? (
            <SidebarMenuSubItem className="w-full px-2 pt-1">
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() =>
                  setVisibleThreadCount((current) => current + initialVisibleResultCount)
                }
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span>{`See more (${threadResults.length - visibleThreadResults.length})`}</span>
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </CommandGroup>
      )}

      {!isFileSearchPending && hasFileResults && (
        <CommandGroup className={cn(hasMessageResults || hasThreadResults ? "mt-2" : undefined)}>
          <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
            Files
          </CommandGroupLabel>
          {visibleFileResults.map((result) => (
            <CommandItem
              key={result.id}
              value={getFileItemValue(result)}
              className="min-h-11 rounded-xl px-3 py-2"
              onSelect={() => onSelectFile(result)}
              onClick={() => onSelectFile(result)}
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
          {fileResults.length > visibleFileResults.length ? (
            <SidebarMenuSubItem className="w-full px-2 pt-1">
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() =>
                  setVisibleFileCount((current) => current + initialVisibleResultCount)
                }
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span>{`See more (${fileResults.length - visibleFileResults.length})`}</span>
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </CommandGroup>
      )}
    </>
  );
}
