import { GitBranchIcon } from "lucide-react";

import { resolveBranchToolbarValue } from "~/components/git/BranchToolbar.logic";

import { MobileFolderIcon } from "../../MobileFolderIcon";

interface MobileComposerContextBarProps {
  projectTitle: string;
  isGitRepo: boolean;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  currentGitBranch: string | null;
}

export function MobileComposerContextBar({
  projectTitle,
  isGitRepo,
  activeThreadBranch,
  activeWorktreePath,
  currentGitBranch,
}: MobileComposerContextBarProps) {
  const branchLabel = resolveBranchToolbarValue({
    envMode: activeWorktreePath ? "worktree" : "local",
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });

  return (
    <div className="flex items-center justify-between gap-3 px-1 pt-2">
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <MobileFolderIcon className="size-3" />
        <span className="truncate">{projectTitle}</span>
      </span>
      {isGitRepo && branchLabel ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranchIcon className="size-3" />
          <span className="max-w-[8rem] truncate">{branchLabel}</span>
        </span>
      ) : null}
    </div>
  );
}
