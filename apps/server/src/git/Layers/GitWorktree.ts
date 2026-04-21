/**
 * GitWorktree - Worktree, workspace, and fetch operations.
 *
 * @module GitWorktree
 */
import { Effect, Path } from "effect";

import { GitCommandError } from "@bigbud/contracts";
import { type GitCoreShape } from "../Services/GitCore.ts";
import {
  splitNullSeparatedPaths,
  chunkPathsForGitCheckIgnore,
  commandLabel,
  createGitCommandError,
} from "./GitCoreUtils.ts";
import { type GitHelpers } from "./GitCoreExecutor.ts";
import type { GitStatusOpsResult } from "./GitStatus.ts";

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

export interface GitWorktreeOps {
  createWorktree: GitCoreShape["createWorktree"];
  removeWorktree: GitCoreShape["removeWorktree"];
  fetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"];
  fetchRemoteBranch: GitCoreShape["fetchRemoteBranch"];
  isInsideWorkTree: GitCoreShape["isInsideWorkTree"];
  listWorkspaceFiles: GitCoreShape["listWorkspaceFiles"];
  filterIgnoredPaths: GitCoreShape["filterIgnoredPaths"];
}

export function makeGitWorktreeOps(
  helpers: GitHelpers,
  statusOps: Pick<GitStatusOpsResult, "branchExists" | "resolvePrimaryRemoteName">,
  path: Path.Path,
  worktreesDir: string,
): GitWorktreeOps {
  const { executeGit, runGit } = helpers;
  const { branchExists, resolvePrimaryRemoteName } = statusOps;

  const createWorktree: GitCoreShape["createWorktree"] = Effect.fn("createWorktree")(
    function* (input) {
      const targetBranch = input.newBranch ?? input.branch;
      const sanitizedBranch = targetBranch.replace(/\//g, "-");
      const repoName = path.basename(input.cwd);
      const worktreePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
      const args = input.newBranch
        ? ["worktree", "add", "-b", input.newBranch, worktreePath, input.branch]
        : ["worktree", "add", worktreePath, input.branch];

      yield* executeGit("GitCore.createWorktree", input.cwd, args, {
        fallbackErrorMessage: "git worktree add failed",
      });

      return {
        worktree: {
          path: worktreePath,
          branch: targetBranch,
        },
      };
    },
  );

  const removeWorktree: GitCoreShape["removeWorktree"] = Effect.fn("removeWorktree")(
    function* (input) {
      const args = ["worktree", "remove"];
      if (input.force) {
        args.push("--force");
      }
      args.push(input.path);
      yield* executeGit("GitCore.removeWorktree", input.cwd, args, {
        timeoutMs: 15_000,
        fallbackErrorMessage: "git worktree remove failed",
      }).pipe(
        Effect.mapError((error) =>
          createGitCommandError(
            "GitCore.removeWorktree",
            input.cwd,
            args,
            `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
        ),
      );
    },
  );

  const fetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"] = Effect.fn(
    "fetchPullRequestBranch",
  )(function* (input): Effect.fn.Return<void, GitCommandError, never> {
    const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
    yield* executeGit(
      "GitCore.fetchPullRequestBranch",
      input.cwd,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        remoteName,
        `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
      ],
      {
        fallbackErrorMessage: "git fetch pull request branch failed",
      },
    );
  });

  const fetchRemoteBranch: GitCoreShape["fetchRemoteBranch"] = Effect.fn("fetchRemoteBranch")(
    function* (input): Effect.fn.Return<void, GitCommandError, never> {
      yield* runGit("GitCore.fetchRemoteBranch.fetch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);

      const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
      const targetRef = `${input.remoteName}/${input.remoteBranch}`;
      yield* runGit(
        "GitCore.fetchRemoteBranch.materialize",
        input.cwd,
        localBranchAlreadyExists
          ? ["branch", "--force", input.localBranch, targetRef]
          : ["branch", input.localBranch, targetRef],
      );
    },
  );

  const isInsideWorkTree: GitCoreShape["isInsideWorkTree"] = (cwd) =>
    executeGit("GitCore.isInsideWorkTree", cwd, ["rev-parse", "--is-inside-work-tree"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).pipe(Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"));

  const listWorkspaceFiles: GitCoreShape["listWorkspaceFiles"] = (cwd) =>
    executeGit(
      "GitCore.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed({
              paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
              truncated: result.stdoutTruncated,
            })
          : Effect.fail(
              createGitCommandError(
                "GitCore.listWorkspaceFiles",
                cwd,
                [
                  ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
                  "ls-files",
                  "--cached",
                  "--others",
                  "--exclude-standard",
                  "-z",
                ],
                result.stderr.trim().length > 0 ? result.stderr.trim() : "git ls-files failed",
              ),
            ),
      ),
    );

  const filterIgnoredPaths: GitCoreShape["filterIgnoredPaths"] = (cwd, relativePaths) =>
    Effect.gen(function* () {
      if (relativePaths.length === 0) {
        return relativePaths;
      }

      const ignoredPaths = new Set<string>();
      const chunks = chunkPathsForGitCheckIgnore(relativePaths, GIT_CHECK_IGNORE_MAX_STDIN_BYTES);

      for (const chunk of chunks) {
        const result = yield* executeGit(
          "GitCore.filterIgnoredPaths",
          cwd,
          [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
          {
            stdin: `${chunk.join("\0")}\0`,
            allowNonZeroExit: true,
            timeoutMs: 20_000,
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        );

        if (result.code !== 0 && result.code !== 1) {
          return yield* createGitCommandError(
            "GitCore.filterIgnoredPaths",
            cwd,
            [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
            result.stderr.trim().length > 0 ? result.stderr.trim() : "git check-ignore failed",
          );
        }

        for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)) {
          ignoredPaths.add(ignoredPath);
        }
      }

      if (ignoredPaths.size === 0) {
        return relativePaths;
      }

      return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
    });

  return {
    createWorktree,
    removeWorktree,
    fetchPullRequestBranch,
    fetchRemoteBranch,
    isInsideWorkTree,
    listWorkspaceFiles,
    filterIgnoredPaths,
  };
}
