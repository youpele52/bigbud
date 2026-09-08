import type { ThreadId } from "@bigbud/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { GitBranchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "~/config/env";
import { BigbudLoader } from "~/components/layout/BigbudLoader";
import { useResolvedGitWorkspace } from "~/hooks/useResolvedGitWorkspace";
import { cn } from "~/lib/utils";
import {
  gitCommitDetailsQueryOptions,
  gitListCommitsInfiniteQueryOptions,
  gitStatusQueryOptions,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import { useGitPanelViewStore } from "~/stores/git/gitPanelView.store";
import { GitPanelChanges } from "./GitPanelChanges";
import { GitPanelHistory } from "./GitPanelHistory";
import { GitPanelPushAction } from "./GitPanelPushAction";
import { ToggleGroup, Toggle } from "../ui/toggle-group";

interface GitPanelProps {
  activeThreadId?: ThreadId | null;
  visible?: boolean;
}

function queryErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
  const gitStatusError = gitStatusQuery.error
    ? queryErrorMessage(gitStatusQuery.error, "The Git status request failed.")
    : null;

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
  }, [cwd, executionTargetId]);

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

  if (gitStatusQuery.isLoading && !gitStatusQuery.data) {
    return <BigbudLoader label="Loading git state..." />;
  }

  if (gitStatusError && !gitStatusQuery.data) {
    return (
      <div className="p-4 text-sm text-destructive">Failed to load Git state: {gitStatusError}</div>
    );
  }

  if (!isGitRepo || !gitStatus) {
    return (
      <div className="space-y-2 p-4 text-sm text-muted-foreground">
        <p>
          No Git repository at <code className="break-all text-foreground">{cwd}</code>.
        </p>
        <p>
          Git uses the project workspace root, not the terminal&apos;s current directory. Edit the
          remote project and set its workspace root to the repository directory.
        </p>
      </div>
    );
  }

  const branchLabel = gitStatus.branch ?? "Detached HEAD";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className={cn("border-b border-border/60 px-3 py-2", isElectron && "drag-region")}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <GitBranchIcon className="size-4" />
              <span className="truncate">{branchLabel}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/80">
              <span>
                {gitStatus.aheadCount > 0 ? `${gitStatus.aheadCount} ahead` : "Up to date"}
                {gitStatus.behindCount > 0 ? `, ${gitStatus.behindCount} behind` : ""}
              </span>
              {gitStatus.aheadCount > 0 ? (
                <GitPanelPushAction
                  activeThreadId={activeThreadId}
                  cwd={cwd}
                  executionTargetId={executionTargetId}
                  gitStatus={gitStatus}
                />
              ) : null}
            </div>
          </div>
          <ToggleGroup
            aria-label="Switch Git panel view"
            className={cn(isElectron && "[-webkit-app-region:no-drag]")}
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
            <Toggle aria-label="Changes" value="changes">
              Changes
            </Toggle>
            <Toggle aria-label="History" value="history">
              History
            </Toggle>
          </ToggleGroup>
        </div>
      </div>
      {gitStatusError ? (
        <div className="border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Git status refresh failed: {gitStatusError}
        </div>
      ) : null}
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
          isLoadingDetails={commitDetailsQuery.isLoading}
          isLoadingHistory={commitHistoryQuery.isLoading}
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
