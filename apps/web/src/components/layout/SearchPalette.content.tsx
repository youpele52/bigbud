import type { MessageId, ThreadId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { useRemoteExecutionAccessGate } from "~/hooks/useRemoteExecutionAccessGate";
import { isRemoteExecutionTargetId } from "~/components/sidebar/Sidebar.remoteWorkspaces.logic";
import { useStore } from "../../stores/main";
import { openPathFromChat } from "../../stores/files/filesPanel.open";
import { useSearchStore, useUiStateStore } from "../../stores/ui";
import { acknowledgeThreadOpen } from "../../lib/threadOrganizationAcknowledge";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandInput,
  CommandList,
  CommandPanel,
} from "../ui/command";
import { joinWorkspaceEntryPath } from "../files/filesPanel.dnd";
import type { FileSearchResult } from "./SearchPalette.results";
import type { ProjectSearchResult } from "./SearchPalette.projectResults";
import { useSectionVisibility } from "./SearchPalette.visibility";
import { useSearchPaletteSources } from "./SearchPalette.sources";
import {
  revealTerminalSearchResult,
  type TerminalSearchResult,
} from "./SearchPalette.terminalResults.logic";
import { SearchPaletteTierSections } from "./SearchPalette.tierSections";

interface SearchPaletteDialogContentProps {
  activeThreadId: ThreadId | null;
}

const INITIAL_VISIBLE_RESULT_COUNT = 5;

export function SearchPaletteDialogContent({ activeThreadId }: SearchPaletteDialogContentProps) {
  const navigate = useNavigate();
  const open = useSearchStore((store) => store.searchOpen);
  const setOpen = useSearchStore((store) => store.setSearchOpen);
  const requestMessageFocus = useSearchStore((store) => store.requestMessageFocus);
  const setSelectedProject = useUiStateStore((state) => state.setSelectedProject);
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const { beginRemoteExecutionTargetAccessCheck } = useRemoteExecutionAccessGate();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const sources = useSearchPaletteSources({ open, query, activeThreadId });
  const { workspaceRoot, debouncedMessageQuery, conversationSearch } = sources;
  const visibility = useSectionVisibility(
    `${open}:${sources.debouncedQuery}`,
    INITIAL_VISIBLE_RESULT_COUNT,
  );

  const handleSelectTerminal = (result: TerminalSearchResult) => {
    setOpen(false);
    revealTerminalSearchResult(result, debouncedMessageQuery);
    if (result.threadId !== activeThreadId) {
      void navigate({ to: "/$threadId", params: { threadId: result.threadId } });
    }
  };

  const handleSelectThread = (threadId: ThreadId) => {
    setOpen(false);
    acknowledgeThreadOpen(threadId);
    void navigate({ to: "/$threadId", params: { threadId } });
  };

  const handleSelectMessage = (threadId: ThreadId, messageId: MessageId) => {
    setOpen(false);
    requestMessageFocus(threadId, messageId);
    acknowledgeThreadOpen(threadId);
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

  const handleSelectProject = (result: ProjectSearchResult) => {
    setOpen(false);
    const selectProject = () => {
      useStore.getState().mergeProjectCatalogPage({
        projectionSequence: 0,
        projects: [result.project],
        remainingCount: 0,
      });
      setSelectedProject(result.project.id);
      setProjectExpanded(result.project.id, true);
    };
    const executionTargetId = result.project.workspaceExecutionTargetId;
    if (!isRemoteExecutionTargetId(executionTargetId)) {
      selectProject();
      return;
    }
    void beginRemoteExecutionTargetAccessCheck({
      executionTargetId,
      ...(result.project.workspaceRoot ? { cwd: result.project.workspaceRoot } : {}),
      onVerified: selectProject,
    });
  };

  const hasMoreMessagePages = conversationSearch.hasNextPage && !conversationSearch.isError;
  const showMoreMessages = (visibleCount: number) => {
    if (visibleCount >= sources.tiers.bigbudData.messages.length && hasMoreMessagePages) {
      void conversationSearch.fetchNextPage();
    }
  };

  const handleSelectCurrentFileMatch = (line: number) => {
    if (!sources.activeFileSearchContext) return;
    sources.activeFileSearchContext.onSelectMatch(line);
    setOpen(false);
  };
  const showResultsPanel = sources.normalizedQuery.length > 0;

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
                    <SearchPaletteTierSections
                      query={query}
                      normalizedQuery={sources.normalizedQuery}
                      tiers={sources.tiers}
                      pending={sources.pending}
                      messageSearchStatus={sources.messageSearchStatus}
                      currentFile={{
                        path: sources.activeFileSearchContext?.path ?? null,
                        matches: sources.currentFileMatches,
                        onSelect: handleSelectCurrentFileMatch,
                      }}
                      visibility={visibility}
                      hasMoreMessagePages={hasMoreMessagePages}
                      onShowMoreMessages={showMoreMessages}
                      onSelectMessage={handleSelectMessage}
                      onSelectThread={handleSelectThread}
                      onSelectProject={handleSelectProject}
                      onSelectFile={handleSelectFile}
                      onSelectTerminal={handleSelectTerminal}
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
