/**
 * GitBranches - Branch listing, checkout, create, rename, and related operations.
 *
 * @module GitBranches
 */
import { Effect, FileSystem } from "effect";

import { GitCommandError } from "@bigbud/contracts";
import { type GitCoreShape } from "../Services/GitCore.ts";
import {
  createGitCommandError,
  deriveLocalBranchNameFromRemoteRef,
  normalizeRemoteUrl,
  parseRemoteFetchUrls,
  parseTrackingBranchByUpstreamRef,
  sanitizeRemoteName,
} from "./GitCoreUtils.ts";
import { makeListBranchesOp } from "./GitBranches.list.ts";
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

  const listBranches = makeListBranchesOp(helpers, fileSystem);

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
