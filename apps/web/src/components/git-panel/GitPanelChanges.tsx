import type { GitStatusResult } from "@bigbud/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { openFileInFilesPanel } from "~/stores/files/filesPanel.coordinator";
import {
  BIGBUD_FILES_PANEL_DRAG_MIME,
  joinWorkspaceEntryPath,
  serializeFilesPanelDragEntry,
} from "../files/filesPanel.dnd";
import { GitPatchViewer } from "./GitPatchViewer";
import { GitPanelSplitView } from "./GitPanelSplitView";

interface GitPanelChangesProps {
  diffError: string | null;
  diffPatch: string;
  gitStatus: GitStatusResult;
  isLoadingDiff: boolean;
  onSelectFile: (path: string) => void;
  selectedFilePath: string | null;
  workspaceRoot: string;
}

export function GitPanelChanges({
  diffError,
  diffPatch,
  gitStatus,
  isLoadingDiff,
  onSelectFile,
  selectedFilePath,
  workspaceRoot,
}: GitPanelChangesProps) {
  const files = gitStatus.workingTree.files;
  const [visibleCount, setVisibleCount] = useState(20);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const visibleFiles = useMemo(() => files.slice(0, visibleCount), [files, visibleCount]);

  useEffect(() => {
    setVisibleCount(20);
  }, [files]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || visibleCount >= files.length) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((current) => Math.min(current + 20, files.length));
      }
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [files.length, visibleCount]);

  if (!gitStatus.hasWorkingTreeChanges) {
    return <div className="p-4 text-sm text-muted-foreground">Working tree is clean.</div>;
  }

  return (
    <GitPanelSplitView
      resizeAriaLabel="Resize git changes list"
      sidebar={
        <>
          <div className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </div>
          <div>
            {visibleFiles.map((file) => {
              const isSelected = file.path === selectedFilePath;
              return (
                <button
                  key={file.path}
                  type="button"
                  draggable
                  className={cn(
                    "flex w-full flex-col border-b border-border/40 px-3 py-2 text-left transition-colors",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/40",
                  )}
                  onDragStart={(event) => {
                    const absolutePath = joinWorkspaceEntryPath(workspaceRoot, file.path);
                    const name = file.path.split("/").at(-1) ?? file.path;
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData(
                      BIGBUD_FILES_PANEL_DRAG_MIME,
                      serializeFilesPanelDragEntry({
                        name,
                        path: absolutePath,
                        entryKind: "file",
                      }),
                    );
                    event.dataTransfer.setData("text/plain", absolutePath);
                  }}
                  onClick={(event) => {
                    onSelectFile(file.path);
                    if ((event.target as HTMLElement).closest("[data-git-file-path]")) {
                      openFileInFilesPanel(file.path);
                    }
                  }}
                >
                  <span
                    data-git-file-path
                    className="truncate text-sm font-medium underline-offset-2 hover:underline"
                  >
                    {file.path}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    +{file.insertions} -{file.deletions}
                  </span>
                </button>
              );
            })}
            {visibleCount < files.length ? (
              <div ref={loadMoreRef} className="px-3 py-2 text-xs text-muted-foreground">
                Scroll for more changed files
              </div>
            ) : null}
          </div>
        </>
      }
      main={
        diffError ? (
          <div className="p-4 text-sm text-destructive">{diffError}</div>
        ) : isLoadingDiff ? (
          <div className="p-4 text-sm text-muted-foreground">Loading diff...</div>
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <GitPatchViewer emptyLabel="No diff available for this file." patch={diffPatch} />
          </div>
        )
      }
    />
  );
}
