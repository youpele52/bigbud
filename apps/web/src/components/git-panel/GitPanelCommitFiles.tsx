import type { GitCommitFileStat } from "@bigbud/contracts";

import { cn } from "~/lib/utils";

interface GitPanelCommitFilesProps {
  files: ReadonlyArray<GitCommitFileStat>;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

/** The changed files of one commit; selecting one loads only that file's patch. */
export function GitPanelCommitFiles({
  files,
  selectedPath,
  onSelectFile,
}: GitPanelCommitFilesProps) {
  if (files.length === 0) {
    return <div className="p-3 text-xs text-muted-foreground">No files changed.</div>;
  }
  return (
    <div role="listbox" aria-label="Changed files" className="overflow-auto">
      {files.map((file) => {
        const selected = file.path === selectedPath;
        return (
          <div
            key={`${file.oldPath ?? ""}\0${file.path}`}
            role="option"
            aria-selected={selected}
            tabIndex={0}
            className={cn(
              "flex items-center gap-2 border-b border-border/40 px-3 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
            )}
            onClick={() => onSelectFile(file.path)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectFile(file.path);
              }
            }}
          >
            <span className="min-w-0 flex-1 truncate" title={file.path}>
              {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {file.binary ? "binary" : `+${file.insertions} −${file.deletions}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
