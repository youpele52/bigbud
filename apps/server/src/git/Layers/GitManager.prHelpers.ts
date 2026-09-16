/**
 * Pull-request upstream configuration and head branch materialization helpers.
 *
 * Each exported factory receives the required service instances and returns
 * closures that operate on those services. No Effect service yielding happens
 * at the module level — all Effects are produced by the returned functions.
 *
 * @module GitManager.prHelpers
 */
import { Effect } from "effect";

import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitHubCliShape } from "../Services/GitHubCli.ts";
import { resolveHeadRepositoryNameWithOwner, shouldPreferSshRemote } from "./GitManager.prUtils.ts";
import type { PullRequestHeadRemoteInfo, ResolvedPullRequest } from "./GitManager.types.ts";
import { gitMutationOperationId } from "./GitCoreExecutor.helpers.ts";

export function makePrHelpers(gitCore: GitCoreShape, gitHubCli: GitHubCliShape) {
  const configurePullRequestHeadUpstreamBase = Effect.fn("configurePullRequestHeadUpstream")(
    function* (
      cwd: string,
      pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
      localBranch = pullRequest.headBranch,
      operationId?: string,
    ) {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";
      if (repositoryNameWithOwner.length === 0) {
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
        operationId: gitMutationOperationId(operationId, "ensureRemote"),
      });

      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        operationId: gitMutationOperationId(operationId, "setBranchUpstream"),
      });
    },
  );

  const configurePullRequestHeadUpstream = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
    operationId?: string,
  ) =>
    configurePullRequestHeadUpstreamBase(cwd, pullRequest, localBranch, operationId).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitManager.configurePullRequestHeadUpstream: failed to configure upstream for ${localBranch} -> ${pullRequest.headBranch} in ${cwd}: ${error.message}`,
        ).pipe(Effect.asVoid),
      ),
    );

  const materializePullRequestHeadBranchBase = Effect.fn("materializePullRequestHeadBranch")(
    function* (
      cwd: string,
      pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
      localBranch = pullRequest.headBranch,
      operationId?: string,
    ) {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";

      if (repositoryNameWithOwner.length === 0) {
        yield* gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
          operationId: gitMutationOperationId(operationId, "fetchPullRequestBranch"),
        });
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
        operationId: gitMutationOperationId(operationId, "ensureRemote"),
      });

      yield* gitCore.fetchRemoteBranch({
        cwd,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        localBranch,
        operationId: gitMutationOperationId(operationId, "fetchRemoteBranch"),
      });
      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        operationId: gitMutationOperationId(operationId, "setBranchUpstream"),
      });
    },
  );

  const materializePullRequestHeadBranch = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
    operationId?: string,
  ) =>
    materializePullRequestHeadBranchBase(cwd, pullRequest, localBranch, operationId).pipe(
      Effect.catch(() =>
        gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
          operationId: gitMutationOperationId(operationId, "fetchPullRequestBranch.fallback"),
        }),
      ),
    );

  return {
    configurePullRequestHeadUpstream,
    materializePullRequestHeadBranch,
  };
}
