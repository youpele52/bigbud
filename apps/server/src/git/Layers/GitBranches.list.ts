import { Effect } from "effect";

import { dedupeRemoteBranchesWithLocalMatches } from "@bigbud/shared/git";
import { type GitCoreShape } from "../Services/GitCore.ts";
import { parseRemoteNames, parseRemoteRefWithRemoteNames } from "../remoteRefs.ts";
import { buildRemoteWebLinks } from "../remoteWebLinks.ts";
import {
  createGitCommandError,
  filterBranchesForListQuery,
  isMissingGitCwdError,
  paginateBranches,
  parseBranchLine,
  parseRemoteFetchUrls,
} from "./GitCoreUtils.ts";
import { type GitHelpers } from "./GitCoreExecutor.ts";

export function parseWorktreeBranchPaths(stdout: string): Map<string, string> {
  const worktreeMap = new Map<string, string>();
  for (const record of stdout.split(/\r?\n\r?\n/g)) {
    const lines = record.split(/\r?\n/g);
    if (lines.some((line) => line.startsWith("prunable"))) continue;
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
    if (!worktreeLine || !branchLine) continue;
    worktreeMap.set(
      branchLine.slice("branch refs/heads/".length),
      worktreeLine.slice("worktree ".length),
    );
  }
  return worktreeMap;
}

export function makeListBranchesOp(helpers: GitHelpers): GitCoreShape["listBranches"] {
  const { executeGit } = helpers;

  const readBranchMetadata = Effect.fn("readBranchMetadata")(function* (cwd: string) {
    const branchMetadata = yield* executeGit(
      "GitCore.readBranchMetadata",
      cwd,
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)",
        "refs/heads",
        "refs/remotes",
      ],
      {
        timeoutMs: 15_000,
        allowNonZeroExit: true,
      },
    );

    const branchLastCommit = new Map<string, number>();
    const localUpstreamRefs = new Map<string, string>();
    if (branchMetadata.code !== 0) {
      return { available: false, branchLastCommit, localUpstreamRefs };
    }

    for (const line of branchMetadata.stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const [name, lastCommitRaw, upstreamRef = ""] = line.split("\t");
      if (!name) {
        continue;
      }
      const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
      if (upstreamRef.length > 0) {
        localUpstreamRefs.set(name, upstreamRef);
      }
    }

    return { available: true, branchLastCommit, localUpstreamRefs };
  });

  return Effect.fn("listBranches")(function* (input) {
    const branchMetadataPromise = readBranchMetadata(input.cwd).pipe(
      Effect.catch(() =>
        Effect.succeed({
          available: false,
          branchLastCommit: new Map<string, number>(),
          localUpstreamRefs: new Map<string, string>(),
        }),
      ),
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

    const remoteFetchUrlsResultEffect = executeGit(
      "GitCore.listBranches.remoteFetchUrls",
      input.cwd,
      ["remote", "-v"],
      {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitCore.listBranches: remote fetch URL lookup failed for ${input.cwd}: ${error.message}. Omitting branch web links.`,
        ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
      ),
    );

    const [
      defaultRef,
      worktreeList,
      remoteBranchResult,
      remoteNamesResult,
      remoteFetchUrlsResult,
      branchMetadata,
    ] = yield* Effect.all(
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
        remoteFetchUrlsResultEffect,
        branchMetadataPromise,
      ],
      { concurrency: "unbounded" },
    );

    const remoteNames =
      remoteNamesResult.code === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
    const remoteFetchUrls =
      remoteFetchUrlsResult.code === 0
        ? parseRemoteFetchUrls(remoteFetchUrlsResult.stdout)
        : new Map<string, string>();
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
    if (remoteFetchUrlsResult.code !== 0 && remoteFetchUrlsResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitCore.listBranches: remote fetch URL lookup returned code ${remoteFetchUrlsResult.code} for ${input.cwd}: ${remoteFetchUrlsResult.stderr.trim()}. Omitting branch web links.`,
      );
    }

    const webLinkForRemote = (remoteName: string, branchName: string) => {
      const remoteUrl = remoteFetchUrls.get(remoteName);
      return remoteUrl ? buildRemoteWebLinks(remoteUrl, branchName) : null;
    };

    const fallbackWebLinkForLocalBranch = (branchName: string) => {
      const originLink = webLinkForRemote("origin", branchName);
      if (originLink) return originLink;

      for (const [remoteName] of remoteFetchUrls) {
        const webLink = webLinkForRemote(remoteName, branchName);
        if (webLink) return webLink;
      }
      return null;
    };

    const defaultBranch =
      defaultRef.code === 0
        ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    const worktreeMap =
      worktreeList.code === 0
        ? parseWorktreeBranchPaths(worktreeList.stdout)
        : new Map<string, string>();

    const localBranches = localBranchResult.stdout
      .split("\n")
      .map(parseBranchLine)
      .filter((branch): branch is { name: string; current: boolean } => branch !== null)
      .map((branch) => {
        const upstreamRef = branchMetadata.localUpstreamRefs.get(branch.name);
        const parsedUpstream = upstreamRef
          ? parseRemoteRefWithRemoteNames(upstreamRef, remoteNames)
          : null;
        const webLink = branchMetadata.available
          ? upstreamRef
            ? parsedUpstream
              ? webLinkForRemote(parsedUpstream.remoteName, parsedUpstream.branchName)
              : null
            : fallbackWebLinkForLocalBranch(branch.name)
          : null;

        const localBranch: {
          name: string;
          current: boolean;
          isRemote: boolean;
          isDefault: boolean;
          worktreePath: string | null;
          webLink?: NonNullable<ReturnType<typeof buildRemoteWebLinks>>;
        } = {
          name: branch.name,
          current: branch.current,
          isRemote: false,
          isDefault: branch.name === defaultBranch,
          worktreePath: worktreeMap.get(branch.name) ?? null,
        };
        if (webLink) {
          localBranch.webLink = webLink;
        }
        return localBranch;
      })
      .toSorted((a, b) => {
        const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
        const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aLastCommit = branchMetadata.branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchMetadata.branchLastCommit.get(b.name) ?? 0;
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
                worktreePath: null;
                webLink?: NonNullable<ReturnType<typeof buildRemoteWebLinks>>;
              } = {
                name: branch.name,
                current: false,
                isRemote: true,
                isDefault: false,
                worktreePath: null,
              };
              if (parsedRemoteRef) {
                remoteBranch.remoteName = parsedRemoteRef.remoteName;
                const webLink = webLinkForRemote(
                  parsedRemoteRef.remoteName,
                  parsedRemoteRef.branchName,
                );
                if (webLink) {
                  remoteBranch.webLink = webLink;
                }
              }
              return remoteBranch;
            })
            .toSorted((a, b) => {
              const aLastCommit = branchMetadata.branchLastCommit.get(a.name) ?? 0;
              const bLastCommit = branchMetadata.branchLastCommit.get(b.name) ?? 0;
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
}
