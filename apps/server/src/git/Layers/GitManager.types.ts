/**
 * Local interfaces and type aliases used within the GitManager layer.
 *
 * These are not exported from the package — they exist solely to provide
 * shared shape definitions for the various GitManager sub-modules.
 *
 * @module GitManager.types
 */
import type { GitActionProgressEvent, GitStackedAction } from "@bigbud/contracts";

export type StripProgressContext<T> = T extends unknown
  ? Omit<T, "actionId" | "cwd" | "action">
  : never;
export type GitActionProgressPayload = StripProgressContext<GitActionProgressEvent>;
export type GitActionProgressEmitter = (
  event: GitActionProgressPayload,
) => import("effect").Effect.Effect<void, never>;

export interface OpenPrInfo {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}

export interface PullRequestHeadRemoteInfo {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}

export interface PullRequestInfo extends OpenPrInfo, PullRequestHeadRemoteInfo {
  state: "open" | "closed" | "merged";
  updatedAt: string | null;
}

export interface ResolvedPullRequest {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
}

export interface BranchHeadContext {
  localBranch: string;
  headBranch: string;
  headSelectors: ReadonlyArray<string>;
  preferredHeadSelector: string;
  remoteName: string | null;
  headRepositoryNameWithOwner: string | null;
  headRepositoryOwnerLogin: string | null;
  isCrossRepository: boolean;
}

export interface CommitAndBranchSuggestion {
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

export function isCommitAction(
  action: GitStackedAction,
): action is "commit" | "commit_push" | "commit_push_pr" {
  return action === "commit" || action === "commit_push" || action === "commit_push_pr";
}
