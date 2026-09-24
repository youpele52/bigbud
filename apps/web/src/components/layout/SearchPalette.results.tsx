import { type MessageId, type ProjectFileContentMatch, type ThreadId } from "@bigbud/contracts";
import {
  CONVERSATION_SEARCH_MAX_QUERY_LENGTH,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
} from "@bigbud/contracts/orchestration/orchestration.search";
import { countUnicodeCodePoints } from "@bigbud/shared/String";
import { FileIcon, MessageSquareIcon } from "lucide-react";

import { CommandGroup, CommandGroupLabel, CommandItem } from "../ui/command";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar.menu";
import { cn } from "~/lib/utils";
import { ProjectSearchResultGroup, type ProjectSearchResult } from "./SearchPalette.projectResults";
import { SearchPaletteCurrentFileResults } from "./SearchPalette.currentFileResults";
import { SearchPaletteMessageResults } from "./SearchPalette.messageResults";
import type { FileSearchMatch } from "./SearchPalette.logic";

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
  isProjectSearchPending: boolean;
  isMessageSearchPending?: boolean;
  messageSearchStatus?: "ready" | "stale" | "unavailable" | undefined;
  currentFilePath: string | null;
  currentFileMatches: readonly FileSearchMatch[];
  visibleCurrentFileMatches: readonly FileSearchMatch[];
  setVisibleCurrentFileMatchCount: React.Dispatch<React.SetStateAction<number>>;
  inThreadMessageResults: MessageSearchResult[];
  otherThreadMessageResults: MessageSearchResult[];
  visibleOtherThreadMessageResults: MessageSearchResult[];
  visibleOtherMessageCount: number;
  setVisibleOtherMessageCount: React.Dispatch<React.SetStateAction<number>>;
  hasMoreMessagePages?: boolean;
  onShowMoreMessages?: () => void;
  threadResults: ThreadSearchResult[];
  visibleThreadResults: ThreadSearchResult[];
  setVisibleThreadCount: React.Dispatch<React.SetStateAction<number>>;
  projectResults: ProjectSearchResult[];
  visibleProjectResults: ProjectSearchResult[];
  setVisibleProjectCount: React.Dispatch<React.SetStateAction<number>>;
  fileResults: FileSearchResult[];
  visibleFileResults: FileSearchResult[];
  setVisibleFileCount: React.Dispatch<React.SetStateAction<number>>;
  hasMessageResults: boolean;
  hasThreadResults: boolean;
  hasProjectResults: boolean;
  hasFileResults: boolean;
  onSelectMessage: (threadId: ThreadId, messageId: MessageId) => void;
  onSelectThread: (threadId: ThreadId) => void;
  onSelectProject: (result: ProjectSearchResult) => void;
  onSelectFile: (result: FileSearchResult) => void;
  onSelectCurrentFileMatch: (line: number) => void;
  initialVisibleResultCount: number;
}

export function SearchPaletteResults({
  query,
  normalizedQuery,
  isSearchPending,
  isFileSearchPending,
  isProjectSearchPending,
  isMessageSearchPending = false,
  messageSearchStatus,
  currentFilePath,
  currentFileMatches,
  visibleCurrentFileMatches,
  setVisibleCurrentFileMatchCount,
  inThreadMessageResults,
  otherThreadMessageResults,
  visibleOtherThreadMessageResults,
  setVisibleOtherMessageCount,
  hasMoreMessagePages = false,
  onShowMoreMessages,
  threadResults,
  visibleThreadResults,
  setVisibleThreadCount,
  projectResults,
  visibleProjectResults,
  setVisibleProjectCount,
  fileResults,
  visibleFileResults,
  setVisibleFileCount,
  hasMessageResults,
  hasThreadResults,
  hasProjectResults,
  hasFileResults,
  onSelectMessage,
  onSelectThread,
  onSelectProject,
  onSelectFile,
  onSelectCurrentFileMatch,
  initialVisibleResultCount,
}: SearchPaletteResultsProps) {
  const hasResults = hasMessageResults || hasProjectResults || hasThreadResults || hasFileResults;
  const messageQueryLength = countUnicodeCodePoints(query.trim());

  return (
    <>
      {!isSearchPending && currentFilePath ? (
        <SearchPaletteCurrentFileResults
          path={currentFilePath}
          query={query}
          matches={currentFileMatches}
          visibleMatches={visibleCurrentFileMatches}
          onSelect={onSelectCurrentFileMatch}
          onShowMore={() =>
            setVisibleCurrentFileMatchCount((current) => current + initialVisibleResultCount)
          }
        />
      ) : null}

      {(isSearchPending ||
        isFileSearchPending ||
        isProjectSearchPending ||
        isMessageSearchPending) &&
        normalizedQuery && (
          <div className="px-4 py-8 text-center text-muted-foreground text-sm">Searching...</div>
        )}

      {!isSearchPending && messageQueryLength < CONVERSATION_SEARCH_MIN_QUERY_LENGTH && (
        <div className="px-4 py-2 text-xs text-muted-foreground">
          Enter at least 3 characters to search saved messages.
        </div>
      )}
      {!isSearchPending && messageQueryLength > CONVERSATION_SEARCH_MAX_QUERY_LENGTH && (
        <div className="px-4 py-2 text-xs text-muted-foreground">
          Shorten your query to 160 characters to search saved messages.
        </div>
      )}
      {messageSearchStatus === "stale" && (
        <div className="px-4 py-2 text-xs text-amber-600">
          Saved messages are still catching up.
        </div>
      )}
      {messageSearchStatus === "unavailable" && (
        <div className="px-4 py-2 text-xs text-amber-600">
          Saved message search is temporarily unavailable.
        </div>
      )}

      {!isSearchPending &&
        !isFileSearchPending &&
        !isProjectSearchPending &&
        !isMessageSearchPending &&
        messageSearchStatus !== "unavailable" &&
        !hasResults &&
        !currentFilePath &&
        normalizedQuery && (
          <div className="px-4 py-8 text-center text-muted-foreground text-sm">
            No matching results
          </div>
        )}

      {!isSearchPending && (
        <SearchPaletteMessageResults
          query={query}
          inThreadResults={inThreadMessageResults}
          otherThreadResults={otherThreadMessageResults}
          visibleOtherThreadResults={visibleOtherThreadMessageResults}
          hasMorePages={hasMoreMessagePages}
          onSelect={onSelectMessage}
          onShowMore={
            onShowMoreMessages ??
            (() => setVisibleOtherMessageCount((current) => current + initialVisibleResultCount))
          }
        />
      )}

      {!isSearchPending && !isProjectSearchPending ? (
        <ProjectSearchResultGroup
          query={query}
          results={projectResults}
          visibleResults={visibleProjectResults}
          onSelect={onSelectProject}
          onShowMore={() =>
            setVisibleProjectCount((current) => current + initialVisibleResultCount)
          }
        />
      ) : null}

      {!isSearchPending && hasThreadResults && (
        <CommandGroup className={cn(hasMessageResults || hasProjectResults ? "mt-2" : undefined)}>
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
        <CommandGroup
          className={cn(
            hasMessageResults || hasProjectResults || hasThreadResults ? "mt-2" : undefined,
          )}
        >
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
