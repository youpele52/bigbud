/**
 * GitBranches - Branch listing, checkout, create, rename, and related operations.
 *
 * @module GitBranches
 */
import { Effect, FileSystem } from "effect";

import { GitCommandError } from "@bigbud/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@bigbud/shared/git";
import { type GitCoreShape } from "../Services/GitCore.ts";
import { parseRemoteNames } from "../remoteRefs.ts";
import { parseRemoteRefWithRemoteNames } from "../remoteRefs.ts";
import {
  parseBranchLine,
  filterBranchesForListQuery,
  paginateBranches,
  parseTrackingBranchByUpstreamRef,
  deriveLocalBranchNameFromRemoteRef,
  createGitCommandError,
  sanitizeRemoteName,
  normalizeRemoteUrl,
  parseRemoteFetchUrls,
  isMissingGitCwdError,
} from "./GitCoreUtils.ts";
import { type GitHelpers } from "./GitCoreExecutor.ts";
import type { GitStatusOpsResult } from "./GitStatus.ts";

export interface GitBranchOps {
  listBranches: GitCoreShape["listBranches"];
  checkoutBranch: GitCoreShape["checkoutBranch"];
  createBranch: GitCoreShape["createBranch"];
  renameBranch: GitCoreShape["renameBranch"];
  setBranchUpstream: GitCoreShape["setBranchUpstream"];
  listLocalBranchNames: GitCoreShape["listLocalBranchNames"];
  initRepo: GitCoreShape["initRepo"];
  ensureRemote: GitCoreShape["ensureRemote"];
}

export function makeGitBranchOps(
  helpers: GitHelpers,
  statusOps: Pick<GitStatusOpsResult, "branchExists">,
  fileSystem: FileSystem.FileSystem,
): GitBranchOps {
  const { executeGit, runGit, runGitStdout } = helpers;
  const { branchExists } = statusOps;

  const readBranchRecency = Effect.fn("readBranchRecency")(function* (cwd: string) {
    const branchRecency = yield* executeGit(
      "GitCore.readBranchRecency",
      cwd,
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(committerdate:unix)",
        "refs/heads",
        "refs/remotes",
      ],
      {
        timeoutMs: 15_000,
        allowNonZeroExit: true,
      },
    );

    const branchLastCommit = new Map<string, number>();
    if (branchRecency.code !== 0) {
      return branchLastCommit;
    }

    for (const line of branchRecency.stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const [name, lastCommitRaw] = line.split("\t");
      if (!name) {
        continue;
      }
      const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
    }

    return branchLastCommit;
  });

  const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
    cwd: string,
    desiredBranch: string,
  ) {
    const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
    if (!isDesiredTaken) {
      return desiredBranch;
    }

    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = `${desiredBranch}-${suffix}`;
      const isCandidateTaken = yield* branchExists(cwd, candidate);
      if (!isCandidateTaken) {
        return candidate;
      }
    }

    return yield* createGitCommandError(
      "GitCore.renameBranch",
      cwd,
      ["branch", "-m", "--", desiredBranch],
      `Could not find an available branch name for '${desiredBranch}'.`,
    );
  });

  const listBranches: GitCoreShape["listBranches"] = Effect.fn("listBranches")(function* (input) {
    const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
      Effect.catch(() => Effect.succeed(new Map<string, number>())),
    );
    const localBranchResult = yield* executeGit(
      "GitCore.listBranches.branchNoColor",
      input.cwd,
      ["branch", "--no-color", "--no-column"],
      {
        timeoutMs: 10_000,
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catchIf(isMissingGitCwdError, () =>
        Effect.succeed({
          code: 128,
          stdout: "",
          stderr: "fatal: not a git repository",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      ),
    );

    if (localBranchResult.code !== 0) {
      const stderr = localBranchResult.stderr.trim();
      if (stderr.toLowerCase().includes("not a git repository")) {
        return {
          branches: [],
          isRepo: false,
          hasOriginRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }
      return yield* createGitCommandError(
        "GitCore.listBranches",
        input.cwd,
        ["branch", "--no-color", "--no-column"],
        stderr || "git branch failed",
      );
    }

    const remoteBranchResultEffect = executeGit(
      "GitCore.listBranches.remoteBranches",
      input.cwd,
      ["branch", "--no-color", "--no-column", "--remotes"],
      {
        timeoutMs: 10_000,
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitCore.listBranches: remote branch lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote branch list.`,
        ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
      ),
    );

    const remoteNamesResultEffect = executeGit(
      "GitCore.listBranches.remoteNames",
      input.cwd,
      ["remote"],
      {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitCore.listBranches: remote name lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote name list.`,
        ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
      ),
    );

    const [defaultRef, worktreeList, remoteBranchResult, remoteNamesResult, branchLastCommit] =
      yield* Effect.all(
        [
          executeGit(
            "GitCore.listBranches.defaultRef",
            input.cwd,
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
          executeGit(
            "GitCore.listBranches.worktreeList",
            input.cwd,
            ["worktree", "list", "--porcelain"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
          remoteBranchResultEffect,
          remoteNamesResultEffect,
          branchRecencyPromise,
        ],
        { concurrency: "unbounded" },
      );

    const remoteNames =
      remoteNamesResult.code === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
    if (remoteBranchResult.code !== 0 && remoteBranchResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitCore.listBranches: remote branch lookup returned code ${remoteBranchResult.code} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote branch list.`,
      );
    }
    if (remoteNamesResult.code !== 0 && remoteNamesResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitCore.listBranches: remote name lookup returned code ${remoteNamesResult.code} for ${input.cwd}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
      );
    }

    const defaultBranch =
      defaultRef.code === 0
        ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    const worktreeMap = new Map<string, string>();
    if (worktreeList.code === 0) {
      let currentPath: string | null = null;
      for (const line of worktreeList.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          const candidatePath = line.slice("worktree ".length);
          const exists = yield* fileSystem.stat(candidatePath).pipe(
            Effect.map(() => true),
            Effect.catch(() => Effect.succeed(false)),
          );
          currentPath = exists ? candidatePath : null;
        } else if (line.startsWith("branch refs/heads/") && currentPath) {
          worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
        } else if (line === "") {
          currentPath = null;
        }
      }
    }

    const localBranches = localBranchResult.stdout
      .split("\n")
      .map(parseBranchLine)
      .filter((branch): branch is { name: string; current: boolean } => branch !== null)
      .map((branch) => ({
        name: branch.name,
        current: branch.current,
        isRemote: false,
        isDefault: branch.name === defaultBranch,
        worktreePath: worktreeMap.get(branch.name) ?? null,
      }))
      .toSorted((a, b) => {
        const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
        const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aLastCommit = branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchLastCommit.get(b.name) ?? 0;
        if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
        return a.name.localeCompare(b.name);
      });

    const remoteBranches =
      remoteBranchResult.code === 0
        ? remoteBranchResult.stdout
            .split("\n")
            .map(parseBranchLine)
            .filter((branch): branch is { name: string; current: boolean } => branch !== null)
            .map((branch) => {
              const parsedRemoteRef = parseRemoteRefWithRemoteNames(branch.name, remoteNames);
              const remoteBranch: {
                name: string;
                current: boolean;
                isRemote: boolean;
                remoteName?: string;
                isDefault: boolean;
                worktreePath: string | null;
              } = {
                name: branch.name,
                current: false,
                isRemote: true,
                isDefault: false,
                worktreePath: null,
              };
              if (parsedRemoteRef) {
                remoteBranch.remoteName = parsedRemoteRef.remoteName;
              }
              return remoteBranch;
            })
            .toSorted((a, b) => {
              const aLastCommit = branchLastCommit.get(a.name) ?? 0;
              const bLastCommit = branchLastCommit.get(b.name) ?? 0;
              if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
              return a.name.localeCompare(b.name);
            })
        : [];

    const branches = paginateBranches({
      branches: filterBranchesForListQuery(
        dedupeRemoteBranchesWithLocalMatches([...localBranches, ...remoteBranches]),
        input.query,
      ),
      cursor: input.cursor,
      limit: input.limit,
    });

    return {
      branches: [...branches.branches],
      isRepo: true,
      hasOriginRemote: remoteNames.includes("origin"),
      nextCursor: branches.nextCursor,
      totalCount: branches.totalCount,
    };
  });

  const checkoutBranch: GitCoreShape["checkoutBranch"] = Effect.fn("checkoutBranch")(
    function* (input) {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitCore.checkoutBranch.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
          executeGit(
            "GitCore.checkoutBranch.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitCore.checkoutBranch.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.code === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.branch)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.branch);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitCore.checkoutBranch.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.code === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.branch]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.branch]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.branch]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.branch];

      yield* executeGit("GitCore.checkoutBranch.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout failed",
      });

      const branchResult = yield* executeGit(
        "GitCore.checkoutBranch.currentBranch",
        input.cwd,
        ["branch", "--show-current"],
        { timeoutMs: 5_000, allowNonZeroExit: true },
      );
      const branch = branchResult.code === 0 ? branchResult.stdout.trim() || null : null;
      return { branch };
    },
  );

  const renameBranch: GitCoreShape["renameBranch"] = Effect.fn("renameBranch")(
    function* (input): Effect.fn.Return<{ branch: string }, GitCommandError, never> {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }
      const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

      yield* executeGit(
        "GitCore.renameBranch",
        input.cwd,
        ["branch", "-m", "--", input.oldBranch, targetBranch],
        {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch rename failed",
        },
      );

      return { branch: targetBranch };
    },
  );

  const createBranch: GitCoreShape["createBranch"] = Effect.fn("createBranch")(function* (input) {
    yield* executeGit("GitCore.createBranch", input.cwd, ["branch", input.branch], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git branch create failed",
    });
    if (input.checkout) {
      yield* executeGit("GitCore.createBranch.checkout", input.cwd, ["checkout", input.branch], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout after branch create failed",
      });
    }
    return { branch: input.branch };
  });

  const setBranchUpstream: GitCoreShape["setBranchUpstream"] = (input) =>
    runGit("GitCore.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const listLocalBranchNames: GitCoreShape["listLocalBranchNames"] = (cwd) =>
    runGitStdout("GitCore.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--no-column",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  const initRepo: GitCoreShape["initRepo"] = (input) =>
    executeGit("GitCore.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  const ensureRemote: GitCoreShape["ensureRemote"] = Effect.fn("ensureRemote")(function* (input) {
    const preferredName = sanitizeRemoteName(input.preferredName);
    const normalizedTargetUrl = normalizeRemoteUrl(input.url);
    const remoteFetchUrls = yield* runGitStdout("GitCore.ensureRemote.listRemoteUrls", input.cwd, [
      "remote",
      "-v",
    ]).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

    for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
      if (normalizeRemoteUrl(remoteUrl) === normalizedTargetUrl) {
        return remoteName;
      }
    }

    let remoteName = preferredName;
    let suffix = 1;
    while (remoteFetchUrls.has(remoteName)) {
      remoteName = `${preferredName}-${suffix}`;
      suffix += 1;
    }

    yield* runGit("GitCore.ensureRemote.add", input.cwd, ["remote", "add", remoteName, input.url]);
    return remoteName;
  });

  return {
    listBranches,
    checkoutBranch,
    createBranch,
    renameBranch,
    setBranchUpstream,
    listLocalBranchNames,
    initRepo,
    ensureRemote,
  };
}
