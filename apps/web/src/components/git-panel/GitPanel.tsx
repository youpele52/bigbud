import type { ThreadId } from "@bigbud/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { GitBranchIcon, HistoryIcon, Rows3Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useResolvedGitWorkspace } from "~/hooks/useResolvedGitWorkspace";
import {
  gitCommitDetailsQueryOptions,
  gitListCommitsInfiniteQueryOptions,
  gitStatusQueryOptions,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import { useGitPanelViewStore } from "~/stores/git/gitPanelView.store";
import { GitPanelChanges } from "./GitPanelChanges";
import { GitPanelHistory } from "./GitPanelHistory";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface GitPanelProps {
  activeThreadId?: ThreadId | null;
  visible?: boolean;
}

export function GitPanelContent({ activeThreadId, visible = true }: GitPanelProps) {
  const { cwd, executionTargetId } = useResolvedGitWorkspace(activeThreadId);
  const activeView = useGitPanelViewStore((state) => state.activeView);
  const setActiveView = useGitPanelViewStore((state) => state.setActiveView);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);

  const gitStatusQuery = useQuery({
    ...gitStatusQueryOptions(cwd, executionTargetId),
    enabled: visible && cwd !== null,
  });
  const gitStatus = gitStatusQuery.data ?? null;
  const isGitRepo = gitStatus?.isRepo ?? false;

  const workingTreeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: cwd ?? "",
      ...(executionTargetId ? { executionTargetId } : {}),
      ...(selectedFilePath ? { path: selectedFilePath } : {}),
      enabled:
        visible &&
        activeView === "changes" &&
        isGitRepo &&
        gitStatus?.hasWorkingTreeChanges === true,
    }),
  );
  const commitHistoryQuery = useInfiniteQuery(
    gitListCommitsInfiniteQueryOptions({
      cwd,
      executionTargetId,
      limit: 20,
      enabled: visible && activeView === "history" && isGitRepo,
    }),
  );
  const commitHistory = useMemo(
    () => commitHistoryQuery.data?.pages.flatMap((page) => page.commits) ?? [],
    [commitHistoryQuery.data],
  );
  const commitDetailsQuery = useQuery(
    gitCommitDetailsQueryOptions({
      cwd: cwd ?? "",
      commit: selectedCommitSha ?? "",
      ...(executionTargetId ? { executionTargetId } : {}),
      enabled: visible && activeView === "history" && isGitRepo && selectedCommitSha !== null,
    }),
  );

  useEffect(() => {
    setSelectedFilePath(null);
    setSelectedCommitSha(null);
  }, [cwd]);

  useEffect(() => {
    const files = gitStatus?.workingTree.files ?? [];
    if (files.length === 0) {
      setSelectedFilePath(null);
      return;
    }
    if (selectedFilePath && files.some((file) => file.path === selectedFilePath)) {
      return;
    }
    setSelectedFilePath(files[0]?.path ?? null);
  }, [gitStatus?.workingTree.files, selectedFilePath]);

  useEffect(() => {
    if (commitHistory.length === 0) {
      setSelectedCommitSha(null);
      return;
    }
    if (selectedCommitSha && commitHistory.some((commit) => commit.sha === selectedCommitSha)) {
      return;
    }
    setSelectedCommitSha(commitHistory[0]?.sha ?? null);
  }, [commitHistory, selectedCommitSha]);

  if (!cwd) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Open a project to inspect git state.</div>
    );
  }

  if (gitStatusQuery.isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading git state...</div>;
  }

  if (!isGitRepo || !gitStatus) {
    return <div className="p-4 text-sm text-muted-foreground">Nothing to show here.</div>;
  }

  const branchLabel = gitStatus.branch ?? "Detached HEAD";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="border-b border-border/60 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <GitBranchIcon className="size-4" />
              <span className="truncate">{branchLabel}</span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground/80">
              {gitStatus.aheadCount > 0 ? `${gitStatus.aheadCount} ahead` : "Up to date"}
              {gitStatus.behindCount > 0 ? `, ${gitStatus.behindCount} behind` : ""}
            </div>
          </div>
          <ToggleGroup
            aria-label="Switch Git panel view"
            variant="toolbar"
            size="xs"
            value={[activeView]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "changes" || next === "history") {
                setActiveView(next);
              }
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle aria-label="Show changes" title="Changes" value="changes">
                    <Rows3Icon className="size-3" />
                  </Toggle>
                }
              />
              <TooltipPopup side="bottom">Changes</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle aria-label="Show history" title="History" value="history">
                    <HistoryIcon className="size-3" />
                  </Toggle>
                }
              />
              <TooltipPopup side="bottom">History</TooltipPopup>
            </Tooltip>
          </ToggleGroup>
        </div>
      </div>
      {activeView === "changes" ? (
        <GitPanelChanges
          diffError={
            workingTreeDiffQuery.error instanceof Error
              ? workingTreeDiffQuery.error.message
              : workingTreeDiffQuery.error
                ? "Failed to load diff."
                : null
          }
          diffPatch={workingTreeDiffQuery.data?.diff ?? ""}
          gitStatus={gitStatus}
          isLoadingDiff={workingTreeDiffQuery.isLoading}
          onSelectFile={setSelectedFilePath}
          selectedFilePath={selectedFilePath}
          workspaceRoot={cwd}
        />
      ) : (
        <GitPanelHistory
          commitDetails={commitDetailsQuery.data?.commit ?? null}
          detailError={
            commitDetailsQuery.error instanceof Error
              ? commitDetailsQuery.error.message
              : commitDetailsQuery.error
                ? "Failed to load commit details."
                : null
          }
          hasMoreHistory={commitHistoryQuery.hasNextPage}
          history={commitHistory}
          historyError={
            commitHistoryQuery.error instanceof Error
              ? commitHistoryQuery.error.message
              : commitHistoryQuery.error
                ? "Failed to load git history."
                : null
          }
          isLoadingDetails={commitDetailsQuery.isLoading || commitHistoryQuery.isLoading}
          isLoadingMoreHistory={commitHistoryQuery.isFetchingNextPage}
          onLoadMoreHistory={() => {
            if (!commitHistoryQuery.hasNextPage || commitHistoryQuery.isFetchingNextPage) {
              return Promise.resolve();
            }

            return commitHistoryQuery.fetchNextPage();
          }}
          onSelectCommit={setSelectedCommitSha}
          selectedCommitSha={selectedCommitSha}
          selectedCommitSummary={
            commitHistory.find((commit) => commit.sha === selectedCommitSha) ?? null
          }
        />
      )}
    </div>
  );
}
