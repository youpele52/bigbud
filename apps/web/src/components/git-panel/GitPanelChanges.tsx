import type { GitStatusResult } from "@bigbud/contracts";

import { cn } from "~/lib/utils";
import { GitPatchViewer } from "./GitPatchViewer";
import { GitPanelSplitView } from "./GitPanelSplitView";

interface GitPanelChangesProps {
  diffError: string | null;
  diffPatch: string;
  gitStatus: GitStatusResult;
  isLoadingDiff: boolean;
  onSelectFile: (path: string) => void;
  selectedFilePath: string | null;
}

export function GitPanelChanges({
  diffError,
  diffPatch,
  gitStatus,
  isLoadingDiff,
  onSelectFile,
  selectedFilePath,
}: GitPanelChangesProps) {
  const files = gitStatus.workingTree.files;

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
            {files.map((file) => {
              const isSelected = file.path === selectedFilePath;
              return (
                <button
                  key={file.path}
                  type="button"
                  className={cn(
                    "flex w-full flex-col border-b border-border/40 px-3 py-2 text-left transition-colors",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/40",
                  )}
                  onClick={() => onSelectFile(file.path)}
                >
                  <span className="truncate text-sm font-medium">{file.path}</span>
                  <span className="text-xs text-muted-foreground">
                    +{file.insertions} -{file.deletions}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      }
      main={
        diffError ? (
          <div className="p-4 text-sm text-destructive">{diffError}</div>
        ) : isLoadingDiff ? (
          <div className="p-4 text-sm text-muted-foreground">Loading diff...</div>
        ) : (
          <GitPatchViewer emptyLabel="No diff available for this file." patch={diffPatch} />
        )
      }
    />
  );
}
