import type { GitGetCommitDetailsResult, GitListCommitsResult } from "@bigbud/contracts";

import { cn } from "~/lib/utils";
import { GitPatchViewer } from "./GitPatchViewer";
import { GitPanelSplitView } from "./GitPanelSplitView";

interface GitPanelHistoryProps {
  commitDetails: GitGetCommitDetailsResult["commit"] | null;
  detailError: string | null;
  history: GitListCommitsResult["commits"];
  historyError: string | null;
  isLoadingDetails: boolean;
  onSelectCommit: (sha: string) => void;
  selectedCommitSha: string | null;
}

export function GitPanelHistory({
  commitDetails,
  detailError,
  history,
  historyError,
  isLoadingDetails,
  onSelectCommit,
  selectedCommitSha,
}: GitPanelHistoryProps) {
  if (historyError) {
    return <div className="p-4 text-sm text-destructive">{historyError}</div>;
  }

  if (history.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No commits yet.</div>;
  }

  return (
    <GitPanelSplitView
      resizeAriaLabel="Resize git history list"
      sidebar={
        <div>
          {history.map((commit) => {
            const isSelected = commit.sha === selectedCommitSha;
            return (
              <button
                key={commit.sha}
                type="button"
                className={cn(
                  "flex w-full flex-col border-b border-border/40 px-3 py-2 text-left transition-colors",
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/40",
                )}
                onClick={() => onSelectCommit(commit.sha)}
              >
                <span className="truncate text-sm font-medium">{commit.subject}</span>
                <span className="text-xs text-muted-foreground">{commit.shortSha}</span>
              </button>
            );
          })}
        </div>
      }
      main={
        detailError ? (
          <div className="p-4 text-sm text-destructive">{detailError}</div>
        ) : isLoadingDetails ? (
          <div className="p-4 text-sm text-muted-foreground">Loading commit...</div>
        ) : commitDetails ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="border-b border-border/60 px-3 py-3">
              <div className="text-sm font-medium text-foreground">{commitDetails.subject}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {commitDetails.shortSha} by {commitDetails.authorName}
              </div>
              {commitDetails.body.trim() ? (
                <pre className="mt-2 text-xs whitespace-pre-wrap text-muted-foreground">
                  {commitDetails.body.trim()}
                </pre>
              ) : null}
            </div>
            <GitPatchViewer
              emptyLabel="No patch available for this commit."
              patch={commitDetails.diff}
            />
          </div>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">Select a commit.</div>
        )
      }
    />
  );
}
