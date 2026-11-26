import type { ExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import type { GitCommitDetails } from "@bigbud/contracts";
import { useState } from "react";

import { GitPanelCommitFileDiff } from "./GitPanelCommitFileDiff";
import { GitPanelCommitFiles } from "./GitPanelCommitFiles";

interface GitPanelCommitChangesProps {
  cwd: string;
  commit: GitCommitDetails;
  workspaceRoot: string;
  executionTargetId?: ExecutionTargetId | undefined;
}

/** File list plus the selected file's patch (GitHub Desktop style). Key it by commit sha. */
export function GitPanelCommitChanges({
  cwd,
  commit,
  workspaceRoot,
  executionTargetId,
}: GitPanelCommitChangesProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(commit.files[0]?.path ?? null);
  const selected = commit.files.find((file) => file.path === selectedPath) ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="max-h-[35%] shrink-0 overflow-auto border-b border-border/60">
        <GitPanelCommitFiles
          files={commit.files}
          selectedPath={selectedPath}
          onSelectFile={setSelectedPath}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {selected ? (
          <GitPanelCommitFileDiff
            key={`${selected.oldPath ?? ""}\0${selected.path}`}
            cwd={cwd}
            commit={commit.sha}
            file={selected}
            workspaceRoot={workspaceRoot}
            executionTargetId={executionTargetId}
          />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">Select a file.</div>
        )}
      </div>
    </div>
  );
}
