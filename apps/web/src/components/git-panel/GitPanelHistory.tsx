import type {
  GitCommitSummary,
  GitGetCommitDetailsResult,
  GitListCommitsResult,
} from "@bigbud/contracts";
import { CloudUploadIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { formatRelativeTimeLabel } from "~/utils/timestamp/timestamp.utils";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { GitPatchViewer } from "./GitPatchViewer";
import { GitPanelSplitView } from "./GitPanelSplitView";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface GitPanelHistoryProps {
  commitDetails: GitGetCommitDetailsResult["commit"] | null;
  detailError: string | null;
  hasMoreHistory: boolean | undefined;
  history: GitListCommitsResult["commits"];
  historyError: string | null;
  isLoadingDetails: boolean;
  isLoadingMoreHistory: boolean;
  onLoadMoreHistory: () => Promise<unknown>;
  onSelectCommit: (sha: string) => void;
  selectedCommitSummary: GitCommitSummary | null;
  selectedCommitSha: string | null;
}

export function GitPanelHistory({
  commitDetails,
  detailError,
  hasMoreHistory,
  history,
  historyError,
  isLoadingDetails,
  isLoadingMoreHistory,
  onLoadMoreHistory,
  onSelectCommit,
  selectedCommitSummary,
  selectedCommitSha,
}: GitPanelHistoryProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasMoreHistory || isLoadingMoreHistory) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void onLoadMoreHistory();
      }
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreHistory, isLoadingMoreHistory, onLoadMoreHistory]);

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
                {commit.tags.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {commit.tags.map((tag) => (
                      <Badge
                        key={`${commit.sha}:${tag}`}
                        variant="outline"
                        className="px-1.5 py-0 text-[10px]"
                      >
                        {tag}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="truncate">
                    {commit.shortSha} by {commit.authorName},{" "}
                    {formatRelativeTimeLabel(commit.authoredAt)}
                  </span>
                  {!commit.isPushed ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            className="inline-flex shrink-0 items-center"
                            aria-label="Not pushed"
                          >
                            <CloudUploadIcon className="size-3 text-muted-foreground/80" />
                          </span>
                        }
                      />
                      <TooltipPopup side="bottom">Not pushed</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </span>
              </button>
            );
          })}
          {hasMoreHistory ? (
            <div ref={loadMoreRef} className="px-3 py-2 text-xs text-muted-foreground">
              {isLoadingMoreHistory ? "Loading older history..." : "Scroll for older history"}
            </div>
          ) : null}
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
              {commitDetails.tags.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {commitDetails.tags.map((tag) => (
                    <Badge
                      key={`${commitDetails.sha}:${tag}`}
                      variant="outline"
                      className="px-1.5 py-0 text-[10px]"
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <div className="mt-1 text-xs text-muted-foreground">
                {commitDetails.shortSha} by {commitDetails.authorName},{" "}
                {formatRelativeTimeLabel(commitDetails.authoredAt)}
                {!selectedCommitSummary?.isPushed ? ", not pushed" : ""}
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
