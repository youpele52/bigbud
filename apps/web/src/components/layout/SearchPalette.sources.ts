import { type ThreadId, isBuiltInChatsProject } from "@bigbud/contracts";
import { useOpenedFileRank } from "./SearchPalette.frecency";
import type { SystemSearchTier } from "@bigbud/contracts/search/systemSearch.ts";
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
import { useFastTierQuery, useSlowTierQuery, useSystemSearchStream } from "./SearchPalette.stream";
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

/**
 * Every palette source for one query, already split into tiers. Like Mod+P, fast tiers (T1–T3:
 * messages, threads, projects, terminals, the current file and the current project's files)
 * follow every keystroke; slow tiers (T4–T6) wait for the shared slow-tier debounce.
 */
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

  const normalizedQuery = normalizeQuery(query);
  // Fast server tiers wait FAST_TIER_DEBOUNCE_MS; browser-side matches below use the typed query.
  const fastTier = useFastTierQuery(normalizedQuery);
  const messageQuery = useFastTierQuery(query.trim()).query;
  const slowTier = useSlowTierQuery(normalizedQuery);
  const streamInput = {
    open,
    currentProjectId: context.currentProjectId,
    currentThreadId: context.currentThreadId,
    thisComputer: searchThisComputer,
  };
  const fastStream = useSystemSearchStream({
    ...streamInput,
    query: fastTier.query,
    slowTiers: false,
  });
  const slowStream = useSystemSearchStream({
    ...streamInput,
    query: slowTier.query,
    currentProject: false,
  });
  const streamFor = (tier: SystemSearchTier) =>
    tier === "currentProject" ? fastStream : slowStream;
  const projectCatalogQueries = useQueries({
    queries: (["local", "remote"] as const).map((scope) =>
      projectCatalogSearchQueryOptions({
        scope,
        query: fastTier.query,
        enabled: open && fastTier.query.length > 0,
      }),
    ),
  });
  const conversationSearch = useInfiniteQuery(
    conversationSearchQueryOptions({ query: messageQuery, enabled: open, ...context }),
  );
  const terminalSearch = useTerminalSearchResults({
    query: messageQuery,
    enabled: open,
    threads,
  });

  const messageTiers = useMemo(
    () =>
      conversationSearch.isError
        ? { currentThread: [], currentProject: [], other: [] }
        : partitionMessageTiers(conversationSearch.data?.pages ?? [], context, messageQuery),
    [conversationSearch.data, conversationSearch.isError, context, messageQuery],
  );
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
        ? findFileSearchMatches(activeFileSearchContext.contents, normalizedQuery)
        : [],
    [activeFileSearchContext, normalizedQuery],
  );

  const openedRank = useOpenedFileRank();
  const tiers: SearchPaletteTiers = {
    currentThread: { messages: messageTiers.currentThread, terminals: terminalTiers.currentThread },
    currentProject: {
      messages: messageTiers.currentProject,
      threads: threadTiers.currentProject,
      files: systemSearchTierRows(fastStream.view, "currentProject", openedRank),
    },
    bigbudData: {
      messages: messageTiers.other,
      threads: threadTiers.other,
      projects: projectResults,
      terminals: terminalTiers.other,
    },
    otherProjectFiles: {
      files: systemSearchTierRows(slowStream.view, "otherProjectFiles", openedRank),
    },
    thisComputer: { files: systemSearchTierRows(slowStream.view, "thisComputer", openedRank) },
    remoteOutsideProjects: {
      files: systemSearchTierRows(slowStream.view, "remoteOutsideProjects", openedRank),
    },
  };

  return {
    tiers,
    normalizedQuery,
    slowTierQuery: slowTier.query,
    messageQuery,
    activeFileSearchContext,
    currentFileMatches,
    conversationSearch,
    pending: {
      debounce: slowTier.pending,
      messages: conversationSearch.isFetching,
      files: isSystemSearchTierPending(fastStream.view, "currentProject"),
      projects:
        projectCatalogQueries[0]?.isFetching === true ||
        projectCatalogQueries[1]?.isFetching === true,
      terminals: terminalSearch.isPending,
    },
    systemNotices: systemSearchNotices(fastStream.view, slowStream.view),
    /** Next pages of streamed file tiers, asked for when a tier's "See more" is scrolled to. */
    systemPaging: {
      hasMore: (tier: SystemSearchTier) => streamFor(tier).hasMore(tier),
      loadMore: (tier: SystemSearchTier) => streamFor(tier).loadMore(tier),
    },
    thisComputerNote: thisComputerNote(slowStream.view),
    messageSearchStatus: conversationSearch.isError
      ? ("unavailable" as const)
      : conversationSearch.data?.pages[0]?.status,
  };
}
