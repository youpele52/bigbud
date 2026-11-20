import { type ThreadId, isBuiltInChatsProject } from "@bigbud/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { conversationSearchQueryOptions } from "~/lib/conversationSearchQuery";
import { projectCatalogSearchQueryOptions } from "~/lib/projectCatalogSearchQuery";
import { isVisibleThread } from "~/logic/thread/threadVisibility.logic";
import { useSettings } from "~/hooks/useSettings";
import { useProjectById, useStore, useThreadById } from "../../stores/main";
import { useSearchStore, useUiStateStore } from "../../stores/ui";
import {
  findFileSearchMatches,
  findThreadSearchMatch,
  normalizeQuery,
} from "./SearchPalette.logic";
import { toProjectSearchResults } from "./SearchPalette.projectResults";
import { useSystemSearchStream } from "./SearchPalette.stream";
import {
  isThisComputerSearchOn,
  isSystemSearchTierPending,
  systemSearchNotices,
  systemSearchTierRows,
  thisComputerNote,
} from "./SearchPalette.systemSearch.logic";
import { useTerminalSearchResults } from "./SearchPalette.terminalResults";
import {
  partitionMessageTiers,
  partitionTerminalTiers,
  partitionThreadTiers,
  type SearchContext,
  type SearchPaletteTiers,
} from "./SearchPalette.tiers.logic";

const SEARCH_PALETTE_QUERY_DEBOUNCE_MS = 200;

/** Every palette source for one query, already split into tiers. */
export function useSearchPaletteSources(input: {
  readonly open: boolean;
  readonly query: string;
  readonly activeThreadId: ThreadId | null;
}) {
  const { open, query, activeThreadId } = input;
  const activeFileSearchContext = useSearchStore((store) => store.activeFileSearchContext);
  const projects = useStore(useShallow((store) => store.projects));
  const threads = useStore(useShallow((store) => store.threads.filter(isVisibleThread)));
  const activeThread = useThreadById(activeThreadId);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const selectedProject = useProjectById(activeThread?.projectId ?? selectedProjectId ?? null);
  const searchThisComputer = useSettings(isThisComputerSearchOn);
  const context: SearchContext = useMemo(
    () => ({
      currentThreadId: activeThreadId,
      currentProjectId: selectedProject?.id ?? null,
    }),
    [activeThreadId, selectedProject?.id],
  );

  const [debouncedQuery, debouncer] = useDebouncedValue(
    query,
    { wait: SEARCH_PALETTE_QUERY_DEBOUNCE_MS },
    (state) => ({ isPending: state.isPending }),
  );
  const normalizedQuery = normalizeQuery(query);
  const debouncedNormalizedQuery = query.length > 0 ? normalizeQuery(debouncedQuery) : "";
  const debouncedMessageQuery = debouncedQuery.trim();
  const systemStream = useSystemSearchStream({
    open,
    query: debouncedNormalizedQuery,
    currentProjectId: context.currentProjectId,
    currentThreadId: context.currentThreadId,
    thisComputer: searchThisComputer,
  });
  const systemSearch = systemStream.view;
  const projectCatalogQueries = useQueries({
    queries: (["local", "remote"] as const).map((scope) =>
      projectCatalogSearchQueryOptions({
        scope,
        query: debouncedNormalizedQuery,
        enabled: open && debouncedNormalizedQuery.length > 0,
      }),
    ),
  });
  const conversationSearch = useInfiniteQuery(
    conversationSearchQueryOptions({ query: debouncedMessageQuery, enabled: open, ...context }),
  );
  const terminalSearch = useTerminalSearchResults({
    query: debouncedMessageQuery,
    enabled: open,
    threads,
  });

  const messageTiers = useMemo(
    () =>
      conversationSearch.isError
        ? { currentThread: [], currentProject: [], other: [] }
        : partitionMessageTiers(
            conversationSearch.data?.pages ?? [],
            context,
            debouncedMessageQuery,
          ),
    [conversationSearch.data, conversationSearch.isError, context, debouncedMessageQuery],
  );
  // Thread titles are client-side, so they follow every keystroke without the debounce.
  const threadTiers = useMemo(() => {
    if (!normalizedQuery) return { currentProject: [], other: [] };
    const matches = threads
      .filter((thread) => thread.archivedAt === null && thread.deletingAt === null)
      .flatMap((thread) => {
        const match = findThreadSearchMatch(thread, normalizedQuery);
        if (!match.matches) return [];
        const project = projects.find((candidate) => candidate.id === thread.projectId);
        const projectName =
          project?.name ?? (isBuiltInChatsProject(thread.projectId) ? "Chats" : "Project");
        return [
          {
            id: "",
            threadId: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            projectName,
            matchedMessageText: match.matchedMessageText,
            type: "thread" as const,
          },
        ];
      });
    return partitionThreadTiers(matches, context);
  }, [normalizedQuery, threads, projects, context]);
  const terminalTiers = useMemo(
    () => partitionTerminalTiers(terminalSearch.results, context),
    [terminalSearch.results, context],
  );
  const projectResults = toProjectSearchResults({
    localProjects: projectCatalogQueries[0]?.data?.projects ?? [],
    remoteWorkspaces: projectCatalogQueries[1]?.data?.projects ?? [],
  });
  const currentFileMatches = useMemo(
    () =>
      activeFileSearchContext
        ? findFileSearchMatches(activeFileSearchContext.contents, debouncedNormalizedQuery)
        : [],
    [activeFileSearchContext, debouncedNormalizedQuery],
  );

  const tiers: SearchPaletteTiers = {
    currentThread: { messages: messageTiers.currentThread, terminals: terminalTiers.currentThread },
    currentProject: {
      messages: messageTiers.currentProject,
      threads: threadTiers.currentProject,
      files: systemSearchTierRows(systemSearch, "currentProject"),
    },
    bigbudData: {
      messages: messageTiers.other,
      threads: threadTiers.other,
      projects: projectResults,
      terminals: terminalTiers.other,
    },
    otherProjectFiles: { files: systemSearchTierRows(systemSearch, "otherProjectFiles") },
    thisComputer: { files: systemSearchTierRows(systemSearch, "thisComputer") },
    remoteOutsideProjects: { files: systemSearchTierRows(systemSearch, "remoteOutsideProjects") },
  };

  return {
    tiers,
    normalizedQuery,
    debouncedQuery,
    debouncedMessageQuery,
    activeFileSearchContext,
    currentFileMatches,
    conversationSearch,
    pending: {
      debounce: debouncer.state.isPending,
      messages: conversationSearch.isFetching,
      files: isSystemSearchTierPending(systemSearch, "currentProject"),
      projects:
        projectCatalogQueries[0]?.isFetching === true ||
        projectCatalogQueries[1]?.isFetching === true,
      terminals: terminalSearch.isPending,
    },
    systemNotices: systemSearchNotices(systemSearch),
    systemSearch,
    /** Next pages of streamed file tiers, asked for when a tier's "See more" is scrolled to. */
    systemPaging: { hasMore: systemStream.hasMore, loadMore: systemStream.loadMore },
    thisComputerNote: thisComputerNote(systemSearch),
    messageSearchStatus: conversationSearch.isError
      ? ("unavailable" as const)
      : conversationSearch.data?.pages[0]?.status,
  };
}
