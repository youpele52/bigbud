import type {
  GitCommitSummary,
  GitGetCommitDetailsResult,
  GitListCommitsResult,
} from "@bigbud/contracts";
import { CloudUploadIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { formatRelativeTimeLabel } from "~/utils/timestamp/timestamp.utils";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { showGitCommitCopyMenu } from "./GitPanel.copy";
import { formatGitCommitAuthorNames, GitPanelAuthors } from "./GitPanelAuthors";
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
  const detailContainerRef = useRef<HTMLDivElement>(null);
  const [detailHeaderHeight, setDetailHeaderHeight] = useState(200);

  const handleDetailResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = detailHeaderHeight;

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        const nextHeight = Math.max(60, startHeight + delta);
        setDetailHeaderHeight(nextHeight);
      };
      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [detailHeaderHeight],
  );

  useLayoutEffect(() => {
    const container = detailContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = entry.contentRect.height;
        if (height > 0) {
          setDetailHeaderHeight((prev) => {
            if (prev === 200) return Math.round(height / 3);
            return prev;
          });
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

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
              <div
                key={commit.sha}
                role="button"
                tabIndex={0}
                className={cn(
                  "flex w-full flex-col border-b border-border/40 px-3 py-2 text-left transition-colors select-text outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/40",
                )}
                onClick={() => onSelectCommit(commit.sha)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void showGitCommitCopyMenu({
                    commit,
                    position: { x: event.clientX, y: event.clientY },
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectCommit(commit.sha);
                  }
                }}
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
                  <GitPanelAuthors
                    authors={commit.authors}
                    className="min-w-0 flex-1"
                    textClassName="text-xs text-muted-foreground"
                  />
                  <span className="shrink-0">• {formatRelativeTimeLabel(commit.authoredAt)}</span>
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
              </div>
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
          <div ref={detailContainerRef} className="flex h-full min-h-0 flex-col overflow-hidden">
            <div
              className="border-b border-border/60 px-3 py-3 select-text"
              style={{ height: detailHeaderHeight, overflow: "auto" }}
              onContextMenu={(event) => {
                event.preventDefault();
                void showGitCommitCopyMenu({
                  commit: commitDetails,
                  body: commitDetails.body,
                  position: { x: event.clientX, y: event.clientY },
                });
              }}
            >
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
              <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <span className="truncate">
                  {commitDetails.shortSha} by {formatGitCommitAuthorNames(commitDetails.authors)},{" "}
                  {formatRelativeTimeLabel(commitDetails.authoredAt)}
                </span>
                {!selectedCommitSummary?.isPushed ? (
                  <span className="shrink-0">, not pushed</span>
                ) : null}
              </div>
              {commitDetails.body.trim() ? (
                <pre className="mt-2 text-xs whitespace-pre-wrap text-muted-foreground select-text">
                  {commitDetails.body.trim()}
                </pre>
              ) : null}
            </div>
            <div
              className="z-10 h-[3px] shrink-0 cursor-row-resize select-none hover:bg-primary/30"
              role="separator"
              aria-label="Resize commit details"
              aria-orientation="horizontal"
              onPointerDown={handleDetailResizePointerDown}
            />
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
