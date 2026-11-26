import type { ExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import type { GitCommitFileStat } from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { BigbudLoader } from "~/components/layout/BigbudLoader";
import { gitCommitFileDiffQueryOptions } from "~/lib/gitReactQuery";
import { Button } from "../ui/button";
import { GitPatchViewer } from "./GitPatchViewer";

interface GitPanelCommitFileDiffProps {
  cwd: string;
  commit: string;
  file: GitCommitFileStat;
  workspaceRoot: string;
  executionTargetId?: ExecutionTargetId | undefined;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** One file's patch, loaded on demand; an oversized patch is a typed state, not an error. */
export function GitPanelCommitFileDiff({
  cwd,
  commit,
  file,
  workspaceRoot,
  executionTargetId,
}: GitPanelCommitFileDiffProps) {
  const [loadLarge, setLoadLarge] = useState(false);
  const query = useQuery(
    gitCommitFileDiffQueryOptions({
      cwd,
      commit,
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      ...(loadLarge ? { limit: "large" as const } : {}),
      ...(executionTargetId ? { executionTargetId } : {}),
    }),
  );

  if (query.isLoading) return <BigbudLoader label="Loading diff..." />;
  if (query.error) {
    const message = query.error instanceof Error ? query.error.message : "Could not load diff.";
    return <div className="p-4 text-sm text-destructive">{message}</div>;
  }
  const result = query.data;
  if (!result) return null;
  if (result.tooLarge) {
    return (
      <div className="flex flex-col items-start gap-2 p-4" data-testid="commit-file-diff-too-large">
        <div className="text-sm text-foreground">This diff is too large to show.</div>
        <div className="text-xs text-muted-foreground">
          {file.path} is over {formatBytes(result.limitBytes)}.
        </div>
        {loadLarge ? null : (
          <Button size="sm" variant="outline" onClick={() => setLoadLarge(true)}>
            Load diff anyway
          </Button>
        )}
      </div>
    );
  }
  return (
    <GitPatchViewer
      emptyLabel={file.binary ? "Binary file changed." : "No changes in this file."}
      patch={result.diff ?? ""}
      workspaceRoot={workspaceRoot}
      executionTargetId={executionTargetId}
    />
  );
}
