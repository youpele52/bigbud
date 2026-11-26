import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { isSafeRelativePath } from "./GitCore.ssh.owner.mutation.ts";

/**
 * C06 (B): fixed read recipes for the diff panel and the branch list on a direct SSH target.
 * Each entry is the exact argv the product issues, plus how many trailing repository-relative
 * paths it may carry. The owner runs its own compiled argv for the action (adding
 * `--no-ext-diff --no-textconv` to diffs); nothing here is forwarded as arguments.
 *
 * @module GitCore.ssh.owner.reads
 */
const DIFF_READ_RECIPES = {
  diffStatus: {
    operation: "GitCore.readWorkingTreeDiff.status",
    args: ["status", "--porcelain=1", "--untracked-files=all", "--"],
    paths: [0, 1],
  },
  hasHead: {
    operation: "GitCore.readWorkingTreeDiff.hasHead",
    args: ["rev-parse", "--verify", "HEAD"],
    paths: [0, 0],
  },
  diffAgainstHead: {
    operation: "GitCore.readWorkingTreeDiff.trackedAgainstHead",
    args: ["diff", "--find-renames", "HEAD", "--"],
    paths: [0, 1],
  },
  diffStaged: {
    operation: "GitCore.readWorkingTreeDiff.initial.staged",
    args: ["diff", "--cached", "--find-renames", "--"],
    paths: [0, 1],
  },
  diffUnstaged: {
    operation: "GitCore.readWorkingTreeDiff.initial.unstaged",
    args: ["diff", "--find-renames", "--"],
    paths: [0, 1],
  },
  untrackedFileDiff: {
    operation: "GitCore.readWorkingTreeDiff.untrackedFile",
    args: ["diff", "--no-index", "/dev/null"],
    paths: [1, 1],
  },
  localBranches: {
    operation: "GitCore.listLocalBranchNames",
    args: ["branch", "--list", "--no-column", "--format=%(refname:short)"],
    paths: [0, 0],
  },
} as const satisfies Record<
  string,
  {
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly paths: readonly [number, number];
  }
>;

export type DirectWorkspaceGitDiffReadAction = keyof typeof DIFF_READ_RECIPES;

export interface DirectWorkspaceGitDiffReadRequest {
  readonly action: DirectWorkspaceGitDiffReadAction;
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly paths: ReadonlyArray<string>;
}

export interface DirectWorkspaceGitDiffReadOwner {
  /** Same admission and failure contract as `DirectWorkspaceGitOwner.execute`. */
  readonly execute: (
    request: DirectWorkspaceGitDiffReadRequest,
    signal: AbortSignal,
  ) => Promise<ExecuteGitResult>;
}

/** Match one exact diff-panel or branch-list read; anything else is not owner-supported. */
export function selectDiffRead(
  input: ExecuteGitInput,
): { readonly action: DirectWorkspaceGitDiffReadAction; readonly paths: string[] } | undefined {
  if (
    input.allowNonZeroExit !== true ||
    input.env !== undefined ||
    input.stdin !== undefined ||
    input.progress !== undefined ||
    input.operationId !== undefined ||
    input.timeoutMs !== undefined ||
    input.maxOutputBytes !== undefined ||
    input.truncateOutputAtMaxBytes !== undefined
  ) {
    return undefined;
  }
  for (const action of Object.keys(DIFF_READ_RECIPES) as DirectWorkspaceGitDiffReadAction[]) {
    const recipe = DIFF_READ_RECIPES[action];
    if (input.operation !== recipe.operation) continue;
    if (!recipe.args.every((arg, index) => input.args[index] === arg)) return undefined;
    const paths = input.args.slice(recipe.args.length);
    const [min, max] = recipe.paths;
    if (paths.length < min || paths.length > max || !paths.every(isSafeRelativePath)) {
      return undefined;
    }
    return { action, paths };
  }
  return undefined;
}
