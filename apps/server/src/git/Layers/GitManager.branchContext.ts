/**
 * Branch head context resolution and base branch helpers for GitManager.
 *
 * Accepts service instances as parameters to remain decoupled from the
 * Effect service layer.
 *
 * @module GitManager.branchContext
 */
import { Effect } from "effect";

import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitHubCliShape } from "../Services/GitHubCli.ts";
import { extractBranchNameFromRemoteRef } from "../remoteRefs.ts";
import {
  appendUnique,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parseRepositoryOwnerLogin,
} from "./GitManager.prUtils.ts";
import type { BranchHeadContext } from "./GitManager.types.ts";

export function makeBranchContext(gitCore: GitCoreShape, gitHubCli: GitHubCliShape) {
  const readConfigValueNullable = (cwd: string, key: string) =>
    gitCore.readConfigValue(cwd, key).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolveRemoteRepositoryContext = Effect.fn("resolveRemoteRepositoryContext")(function* (
    cwd: string,
    remoteName: string | null,
  ) {
    if (!remoteName) {
      return {
        repositoryNameWithOwner: null,
        ownerLogin: null,
      };
    }

    const remoteUrl = yield* readConfigValueNullable(cwd, `remote.${remoteName}.url`);
    const repositoryNameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
    return {
      repositoryNameWithOwner,
      ownerLogin: parseRepositoryOwnerLogin(repositoryNameWithOwner),
    };
  });

  const resolveBranchHeadContext = Effect.fn("resolveBranchHeadContext")(function* (
    cwd: string,
    details: { branch: string; upstreamRef: string | null },
  ) {
    const remoteName = yield* readConfigValueNullable(cwd, `branch.${details.branch}.remote`);
    const headBranchFromUpstream = details.upstreamRef
      ? extractBranchNameFromRemoteRef(details.upstreamRef, { remoteName })
      : "";
    const headBranch = headBranchFromUpstream.length > 0 ? headBranchFromUpstream : details.branch;
    const shouldProbeLocalBranchSelector =
      headBranchFromUpstream.length === 0 || headBranch === details.branch;

    const [remoteRepository, originRepository] = yield* Effect.all(
      [
        resolveRemoteRepositoryContext(cwd, remoteName),
        resolveRemoteRepositoryContext(cwd, "origin"),
      ],
      { concurrency: "unbounded" },
    );

    const isCrossRepository =
      remoteRepository.repositoryNameWithOwner !== null &&
      originRepository.repositoryNameWithOwner !== null
        ? remoteRepository.repositoryNameWithOwner.toLowerCase() !==
          originRepository.repositoryNameWithOwner.toLowerCase()
        : remoteName !== null &&
          remoteName !== "origin" &&
          remoteRepository.repositoryNameWithOwner !== null;

    const ownerHeadSelector =
      remoteRepository.ownerLogin && headBranch.length > 0
        ? `${remoteRepository.ownerLogin}:${headBranch}`
        : null;
    const remoteAliasHeadSelector =
      remoteName && headBranch.length > 0 ? `${remoteName}:${headBranch}` : null;
    const shouldProbeRemoteOwnedSelectors =
      isCrossRepository || (remoteName !== null && remoteName !== "origin");

    const headSelectors: string[] = [];
    if (isCrossRepository && shouldProbeRemoteOwnedSelectors) {
      appendUnique(headSelectors, ownerHeadSelector);
      appendUnique(
        headSelectors,
        remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
      );
    }
    if (shouldProbeLocalBranchSelector) {
      appendUnique(headSelectors, details.branch);
    }
    appendUnique(headSelectors, headBranch !== details.branch ? headBranch : null);
    if (!isCrossRepository && shouldProbeRemoteOwnedSelectors) {
      appendUnique(headSelectors, ownerHeadSelector);
      appendUnique(
        headSelectors,
        remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
      );
    }

    return {
      localBranch: details.branch,
      headBranch,
      headSelectors,
      preferredHeadSelector:
        ownerHeadSelector && isCrossRepository ? ownerHeadSelector : headBranch,
      remoteName,
      headRepositoryNameWithOwner: remoteRepository.repositoryNameWithOwner,
      headRepositoryOwnerLogin: remoteRepository.ownerLogin,
      isCrossRepository,
    } satisfies BranchHeadContext;
  });

  const resolveBaseBranch = Effect.fn("resolveBaseBranch")(function* (
    cwd: string,
    branch: string,
    upstreamRef: string | null,
    headContext: Pick<BranchHeadContext, "isCrossRepository" | "remoteName">,
  ) {
    const configured = yield* gitCore.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
    if (configured) return configured;

    if (upstreamRef && !headContext.isCrossRepository) {
      const upstreamBranch = extractBranchNameFromRemoteRef(upstreamRef, {
        remoteName: headContext.remoteName,
      });
      if (upstreamBranch.length > 0 && upstreamBranch !== branch) {
        return upstreamBranch;
      }
    }

    const defaultFromGh = yield* gitHubCli
      .getDefaultBranch({ cwd })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (defaultFromGh) {
      return defaultFromGh;
    }

    return "main";
  });

  return {
    readConfigValueNullable,
    resolveBranchHeadContext,
    resolveBaseBranch,
  };
}
