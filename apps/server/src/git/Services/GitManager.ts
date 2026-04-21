/**
 * GitManager - Effect service contract for stacked Git workflows.
 *
 * Orchestrates status inspection and commit/push/PR flows by composing
 * lower-level Git and external tool services.
 *
 * @module GitManager
 */
import {
  GitActionProgressEvent,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusResult,
} from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { GitManagerServiceError } from "@bigbud/contracts";

export interface GitActionProgressReporter {
  readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void, never>;
}

export interface GitRunStackedActionOptions {
  readonly actionId?: string;
  readonly progressReporter?: GitActionProgressReporter;
}

/**
 * GitManagerShape - Service API for high-level Git workflow actions.
 */
export interface GitManagerShape {
  /**
   * Read current repository Git status plus open PR metadata when available.
   */
  readonly status: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;

  /**
   * Read only the local portion of Git status (no upstream fetch).
   */
  readonly localStatus: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusLocalResult, GitManagerServiceError>;

  /**
   * Read only the remote portion of Git status (ahead/behind + PR).
   */
  readonly remoteStatus: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusRemoteResult, GitManagerServiceError>;

  /**
   * Invalidate the local status cache for the given cwd.
   */
  readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void>;

  /**
   * Invalidate the remote status cache for the given cwd.
   */
  readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void>;

  /**
   * Invalidate both local and remote status caches for the given cwd.
   */
  readonly invalidateStatus: (cwd: string) => Effect.Effect<void>;

  /**
   * Resolve a pull request by URL/number against the current repository.
   */
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;

  /**
   * Prepare a new thread workspace from a pull request in local or worktree mode.
   */
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;

  /**
   * Run a Git action (`commit`, `push`, `create_pr`, `commit_push`, `commit_push_pr`).
   * When `featureBranch` is set, creates and checks out a feature branch first.
   */
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: GitRunStackedActionOptions,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
}

/**
 * GitManager - Service tag for stacked Git workflow orchestration.
 */
export class GitManager extends ServiceMap.Service<GitManager, GitManagerShape>()(
  "t3/git/Services/GitManager",
) {}
