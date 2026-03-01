import type { GitBranch, ThreadId } from "@t3tools/contracts";

interface DeriveSyncedLocalBranchInput {
  activeThreadId: ThreadId | undefined;
  activeWorktreePath: string | null;
  envMode: "local" | "worktree";
  activeThreadBranch: string | null;
  queryBranches: ReadonlyArray<GitBranch> | undefined;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(separatorIndex + 1);
}

export function dedupeRemoteBranchesWithLocalMatches(
  branches: ReadonlyArray<GitBranch>,
): ReadonlyArray<GitBranch> {
  const localBranchNames = new Set(
    branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
  );

  return branches.filter((branch) => {
    if (!branch.isRemote) {
      return true;
    }

    const localBranchName = deriveLocalBranchNameFromRemoteRef(branch.name);
    return !localBranchNames.has(localBranchName);
  });
}

export function deriveSyncedLocalBranch({
  activeThreadId,
  activeWorktreePath,
  envMode,
  activeThreadBranch,
  queryBranches,
}: DeriveSyncedLocalBranchInput): string | null {
  if (!activeThreadId || activeWorktreePath || envMode !== "local") {
    return null;
  }

  const currentBranch = queryBranches?.find((branch) => branch.current);
  if (!currentBranch || currentBranch.name === activeThreadBranch) {
    return null;
  }

  return currentBranch.name;
}
