import { type MessageId, type ThreadId, isBuiltInChatsProject } from "@bigbud/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import { projectSearchFileContentsQueryOptions } from "~/lib/projectReactQuery";
import { resolveWorkspaceExecutionTargetId } from "~/lib/providerExecutionTargets";
import { useDefaultChatCwd } from "~/rpc/serverState";
import { useProjectById, useStore, useThreadById } from "../../stores/main";
import { openPathFromChat } from "../../stores/files/filesPanel.open";
import { useSearchStore, useUiStateStore } from "../../stores/ui";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandInput,
  CommandList,
  CommandPanel,
} from "../ui/command";
import { joinWorkspaceEntryPath } from "../files/filesPanel.dnd";
import {
  findMessageSearchMatches,
  findThreadSearchMatch,
  normalizeQuery,
} from "./SearchPalette.logic";
import {
  SearchPaletteResults,
  toFileSearchResults,
  type MessageSearchResult,
  type ThreadSearchResult,
  type FileSearchResult,
} from "./SearchPalette.results";

interface SearchPaletteDialogContentProps {
  activeThreadId: ThreadId | null;
}

const SEARCH_PALETTE_QUERY_DEBOUNCE_MS = 200;
const INITIAL_VISIBLE_RESULT_COUNT = 5;
const SEARCH_FILE_CONTENT_LIMIT = 40;

export function SearchPaletteDialogContent({ activeThreadId }: SearchPaletteDialogContentProps) {
  const navigate = useNavigate();
  const open = useSearchStore((store) => store.searchOpen);
  const setOpen = useSearchStore((store) => store.setSearchOpen);
  const requestMessageFocus = useSearchStore((store) => store.requestMessageFocus);
  const projects = useStore(useShallow((store) => store.projects));
  const threads = useStore(useShallow((store) => store.threads));
  const activeThread = useThreadById(activeThreadId);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const selectedProject = useProjectById(activeThread?.projectId ?? selectedProjectId ?? null);
  const defaultChatCwd = useDefaultChatCwd();
  const [query, setQuery] = useState("");
  const [visibleOtherMessageCount, setVisibleOtherMessageCount] = useState(
    INITIAL_VISIBLE_RESULT_COUNT,
  );
  const [visibleThreadCount, setVisibleThreadCount] = useState(INITIAL_VISIBLE_RESULT_COUNT);
  const [visibleFileCount, setVisibleFileCount] = useState(INITIAL_VISIBLE_RESULT_COUNT);

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const [debouncedQuery, searchQueryDebouncer] = useDebouncedValue(
    query,
    { wait: SEARCH_PALETTE_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const normalizedQuery = normalizeQuery(query);
  const debouncedNormalizedQuery = query.length > 0 ? normalizeQuery(debouncedQuery) : "";
  const workspaceRoot =
    activeThread?.worktreePath ?? selectedProject?.cwd ?? defaultChatCwd ?? null;
  const workspaceExecutionTargetId = activeThread?.worktreePath
    ? undefined
    : selectedProject
      ? resolveWorkspaceExecutionTargetId(selectedProject)
      : undefined;

  useEffect(() => {
    setVisibleOtherMessageCount(INITIAL_VISIBLE_RESULT_COUNT);
    setVisibleThreadCount(INITIAL_VISIBLE_RESULT_COUNT);
    setVisibleFileCount(INITIAL_VISIBLE_RESULT_COUNT);
  }, [debouncedQuery, open]);

  const fileContentsQuery = useQuery(
    projectSearchFileContentsQueryOptions({
      cwd: workspaceRoot,
      executionTargetId: workspaceExecutionTargetId,
      query: debouncedNormalizedQuery,
      enabled: open && debouncedNormalizedQuery.length > 0,
      limit: SEARCH_FILE_CONTENT_LIMIT,
    }),
  );

  const messageResults = useMemo<MessageSearchResult[]>(() => {
    if (!debouncedNormalizedQuery) return [];

    return threads
      .filter((thread) => thread.archivedAt === null && thread.deletingAt === null)
      .flatMap((thread) => {
        const project = projects.find((p) => p.id === thread.projectId);
        const projectName =
          project?.name ?? (isBuiltInChatsProject(thread.projectId) ? "Chats" : "Project");
        return findMessageSearchMatches(thread, debouncedNormalizedQuery).map((match) => ({
          id: `message:${thread.id}:${match.messageId}`,
          threadId: thread.id,
          messageId: match.messageId,
          threadTitle: thread.title,
          projectName,
          text: match.text,
          snippet: match.snippet,
          matchIndex: match.matchIndex,
          type: "message" as const,
        }));
      });
  }, [debouncedNormalizedQuery, projects, threads]);

  const threadResults = useMemo<ThreadSearchResult[]>(() => {
    if (!debouncedNormalizedQuery) return [];

    return threads
      .filter((thread) => thread.archivedAt === null && thread.deletingAt === null)
      .filter((thread) => findThreadSearchMatch(thread, debouncedNormalizedQuery).matches)
      .map((thread) => {
        const project = projects.find((p) => p.id === thread.projectId);
        const projectName =
          project?.name ?? (isBuiltInChatsProject(thread.projectId) ? "Chats" : "Project");
        const { matchedMessageText } = findThreadSearchMatch(thread, debouncedNormalizedQuery);
        return {
          id: `thread:${thread.id}`,
          threadId: thread.id,
          title: thread.title,
          projectName,
          matchedMessageText,
          type: "thread",
        };
      });
  }, [debouncedNormalizedQuery, threads, projects]);

  const handleSelectThread = (threadId: ThreadId) => {
    setOpen(false);
    void navigate({ to: "/$threadId", params: { threadId } });
  };

  const handleSelectMessage = (threadId: ThreadId, messageId: MessageId) => {
    setOpen(false);
    requestMessageFocus(threadId, messageId);
    if (threadId !== activeThreadId) {
      void navigate({ to: "/$threadId", params: { threadId } });
    }
  };

  const handleSelectFile = (result: FileSearchResult) => {
    if (!workspaceRoot) {
      return;
    }
    setOpen(false);
    void openPathFromChat(
      `${joinWorkspaceEntryPath(workspaceRoot, result.path)}:${result.line}${
        result.column ? `:${result.column}` : ""
      }`,
      workspaceRoot,
    ).catch((error) => {
      console.error("Failed to open file:", error);
    });
  };

  const inThreadMessageResults = messageResults.filter(
    (result) => result.threadId === activeThreadId,
  );
  const otherThreadMessageResults = messageResults.filter(
    (result) => result.threadId !== activeThreadId,
  );
  const fileResults = toFileSearchResults(fileContentsQuery.data?.matches ?? []);
  const isSearchPending = searchQueryDebouncer.state.isPending;
  const isFileSearchPending = fileContentsQuery.isFetching;
  const hasMessageResults = messageResults.length > 0;
  const hasFileResults = fileResults.length > 0;
  const hasThreadResults = threadResults.length > 0;
  const showResultsPanel = normalizedQuery.length > 0;
  const visibleOtherThreadMessageResults = otherThreadMessageResults.slice(
    0,
    visibleOtherMessageCount,
  );
  const visibleThreadResults = threadResults.slice(0, visibleThreadCount);
  const visibleFileResults = fileResults.slice(0, visibleFileCount);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup
        aria-label="Search palette"
        className="mx-auto w-full max-w-[26rem] overflow-visible border-0 bg-transparent p-0 shadow-none before:hidden"
        viewportClassName="items-center justify-center"
        data-testid="search-palette"
      >
        <Command value={query} onValueChange={setQuery}>
          <div className="group rounded-[22px] p-px transition-colors duration-200">
            <div className="rounded-[20px] border border-border bg-card transition-colors duration-200 has-focus-visible:border-ring/45">
              <div
                className={cn(
                  "px-3 py-2 sm:px-4 sm:py-3",
                  !showResultsPanel && "[&_[data-slot=searchbar]]:border-b-0",
                )}
              >
                <CommandInput
                  placeholder="Search"
                  className="h-8 border-transparent! bg-transparent! px-0 text-sm placeholder:text-muted-foreground/65"
                />
              </div>

              {showResultsPanel ? (
                <CommandPanel className="max-h-[min(22rem,50vh)] rounded-t-none border-0 bg-transparent shadow-none [clip-path:none] before:hidden">
                  <CommandList
                    className="px-2 pb-2 sm:px-3 sm:pb-3"
                    scrollAreaClassName="max-h-[min(22rem,50vh)]"
                  >
                    <SearchPaletteResults
                      query={query}
                      normalizedQuery={normalizedQuery}
                      isSearchPending={isSearchPending}
                      isFileSearchPending={isFileSearchPending}
                      inThreadMessageResults={inThreadMessageResults}
                      otherThreadMessageResults={otherThreadMessageResults}
                      visibleOtherThreadMessageResults={visibleOtherThreadMessageResults}
                      visibleOtherMessageCount={visibleOtherMessageCount}
                      setVisibleOtherMessageCount={setVisibleOtherMessageCount}
                      threadResults={threadResults}
                      visibleThreadResults={visibleThreadResults}
                      setVisibleThreadCount={setVisibleThreadCount}
                      fileResults={fileResults}
                      visibleFileResults={visibleFileResults}
                      setVisibleFileCount={setVisibleFileCount}
                      hasMessageResults={hasMessageResults}
                      hasThreadResults={hasThreadResults}
                      hasFileResults={hasFileResults}
                      onSelectMessage={handleSelectMessage}
                      onSelectThread={handleSelectThread}
                      onSelectFile={handleSelectFile}
                      initialVisibleResultCount={INITIAL_VISIBLE_RESULT_COUNT}
                    />
                  </CommandList>
                </CommandPanel>
              ) : null}
            </div>
          </div>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
