import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./GitCoreExecutor.ts";

/** Fixed compiled mutation recipes. No caller-supplied options, cwd, environment or stdin. */
const MUTATION_RECIPES = {
  restoreTrackedPaths: {
    operation: "GitCore.discardChanges.restore",
    args: ["restore", "--source=HEAD", "--staged", "--worktree", "--"],
  },
  cleanUntrackedPaths: {
    operation: "GitCore.discardChanges.clean",
    args: ["clean", "-f", "-q", "--"],
  },
  stagePaths: {
    operation: "GitCore.stagePaths",
    args: ["add", "--"],
  },
} as const;

export type DirectWorkspaceGitMutationAction = keyof typeof MUTATION_RECIPES;

export const DIRECT_WORKSPACE_GIT_MUTATION_LIMITS = {
  restoreTrackedPaths: { timeoutMs: 30_000, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES },
  cleanUntrackedPaths: { timeoutMs: 30_000, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES },
  stagePaths: { timeoutMs: 30_000, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES },
} as const satisfies Record<
  DirectWorkspaceGitMutationAction,
  { timeoutMs: number; maxOutputBytes: number }
>;

/** The discard UI chunks at 200 paths; the owner applies the same bound to one request. */
export const MAX_MUTATION_PATHS = 200;
const MAX_RELATIVE_PATH_BYTES = 4_096;
const LITERAL_TOP_PREFIX = ":(top,literal)";

export interface DirectWorkspaceGitMutationRequest {
  readonly action: DirectWorkspaceGitMutationAction;
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly paths: ReadonlyArray<string>;
  readonly operationId?: string;
}

export interface DirectWorkspaceGitMutationOwner {
  /**
   * Run one fixed mutation recipe against validated repository-relative paths. The owner
   * revalidates the bound workspace and each path before dispatch, quotes paths as data, and
   * binds any in-flight cancellation to this operation identity. A lost or ambiguous result
   * must surface as an error; it must never be replayed as a second command.
   */
  readonly execute: (
    request: DirectWorkspaceGitMutationRequest,
    signal: AbortSignal,
  ) => Promise<ExecuteGitResult>;
}

export interface DirectWorkspaceGitPathReadRequest {
  readonly action: "untrackedNumstat";
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly path: string;
}

export interface DirectWorkspaceGitPathReadOwner {
  /** One bounded `--no-index` line count for an already-validated relative path. */
  readonly execute: (
    request: DirectWorkspaceGitPathReadRequest,
    signal: AbortSignal,
  ) => Promise<ExecuteGitResult>;
}

/** The owner reported an ambiguous mutation/stream result; never replay it. */
export class DirectWorkspaceGitOutcomeUnknown extends Error {
  constructor(readonly outcome: "cancelled" | "outcomeUnknown") {
    super(
      outcome === "cancelled"
        ? "The direct workspace Git operation was cancelled by its owner lease and was not replayed."
        : "The direct workspace Git mutation outcome is unknown and was not replayed.",
    );
    this.name = "DirectWorkspaceGitOutcomeUnknown";
  }
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || Buffer.byteLength(path) > MAX_RELATIVE_PATH_BYTES) return false;
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
  if (path.startsWith("-")) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function literalPathspecPath(arg: string): string | undefined {
  if (!arg.startsWith(LITERAL_TOP_PREFIX)) return undefined;
  const path = arg.slice(LITERAL_TOP_PREFIX.length);
  return isSafeRelativePath(path) ? path : undefined;
}

interface SelectedMutation {
  readonly action: DirectWorkspaceGitMutationAction;
  readonly paths: ReadonlyArray<string>;
  readonly operationId?: string;
}

/** Match one exact mutation invocation; anything else is not an owner-supported mutation. */
export function selectMutation(input: ExecuteGitInput): SelectedMutation | undefined {
  if (
    input.allowNonZeroExit !== true ||
    input.env !== undefined ||
    input.stdin !== undefined ||
    input.progress !== undefined ||
    input.maxOutputBytes !== undefined ||
    input.truncateOutputAtMaxBytes !== undefined
  ) {
    return undefined;
  }

  for (const action of Object.keys(MUTATION_RECIPES) as Array<DirectWorkspaceGitMutationAction>) {
    const recipe = MUTATION_RECIPES[action];
    const limit = DIRECT_WORKSPACE_GIT_MUTATION_LIMITS[action];
    if (
      input.operation !== recipe.operation ||
      (input.timeoutMs !== undefined && input.timeoutMs !== limit.timeoutMs) ||
      input.args.length <= recipe.args.length
    ) {
      continue;
    }
    const prefixMatches = recipe.args.every((arg, index) => input.args[index] === arg);
    if (!prefixMatches) continue;

    const paths: string[] = [];
    let valid = true;
    for (const arg of input.args.slice(recipe.args.length)) {
      const path = literalPathspecPath(arg);
      if (path === undefined) {
        valid = false;
        break;
      }
      paths.push(path);
    }
    if (!valid || paths.length === 0 || paths.length > MAX_MUTATION_PATHS) continue;
    return {
      action,
      paths,
      ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
    };
  }
  return undefined;
}

const UNTRACKED_NUMSTAT_ARGS = [
  "diff",
  "--numstat",
  "--no-index",
  "--no-ext-diff",
  "--no-textconv",
  "/dev/null",
  "--",
] as const;

/** Match the single bounded untracked line-count request. */
export function selectPathRead(input: ExecuteGitInput): { readonly path: string } | undefined {
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
  if (
    input.operation !== "GitCore.statusDetails.fallbackNumstat" &&
    input.operation !== "GitCore.statusDetailsLocal.fallbackNumstat"
  ) {
    return undefined;
  }
  if (input.args.length !== UNTRACKED_NUMSTAT_ARGS.length + 1) return undefined;
  if (!UNTRACKED_NUMSTAT_ARGS.every((arg, index) => input.args[index] === arg)) return undefined;
  const path = input.args[UNTRACKED_NUMSTAT_ARGS.length];
  return path !== undefined && isSafeRelativePath(path) ? { path } : undefined;
}
