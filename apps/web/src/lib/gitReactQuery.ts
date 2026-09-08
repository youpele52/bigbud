// TODO: Split by concern when this file is next touched.
import {
  resolveExecutionTargetId,
  type ExecutionTargetId,
  type GitGetCommitDetailsInput,
  type GitReadWorkingTreeDiffInput,
} from "@bigbud/contracts";
import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../rpc/nativeApi";
export {
  createGitMutationOperationId,
  gitDiscardChangesMutationOptions,
  gitFetchMutationOptions,
  gitInitMutationOptions,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRemoveWorktreeMutationOptions,
  gitRunStackedActionMutationOptions,
  type GitMutationVariables,
} from "./gitReactQuery.mutations";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;
const GIT_BRANCHES_PAGE_SIZE = 100;
const GIT_HISTORY_STALE_TIME_MS = 30_000;

export const gitQueryKeys = {
  all: ["git"] as const,
  status: (cwd: string | null, executionTargetId?: ExecutionTargetId | null | undefined) =>
    ["git", "status", resolveExecutionTargetId(executionTargetId), cwd] as const,
  branches: (cwd: string | null, executionTargetId?: ExecutionTargetId | null | undefined) =>
    ["git", "branches", resolveExecutionTargetId(executionTargetId), cwd] as const,
  commits: (
    cwd: string | null,
    executionTargetId?: ExecutionTargetId | null | undefined,
    limit?: number | undefined,
  ) => ["git", "commits", resolveExecutionTargetId(executionTargetId), cwd, limit ?? null] as const,
  commitDetails: (
    cwd: string | null,
    executionTargetId: ExecutionTargetId | null | undefined,
    commit: string | null,
  ) => ["git", "commit-details", resolveExecutionTargetId(executionTargetId), cwd, commit] as const,
  workingTreeDiff: (
    cwd: string | null,
    executionTargetId: ExecutionTargetId | null | undefined,
    path: string | null,
  ) =>
    ["git", "working-tree-diff", resolveExecutionTargetId(executionTargetId), cwd, path] as const,
  branchSearch: (
    cwd: string | null,
    query: string,
    executionTargetId?: ExecutionTargetId | null | undefined,
  ) =>
    ["git", "branches", resolveExecutionTargetId(executionTargetId), cwd, "search", query] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null, executionTargetId?: ExecutionTargetId | null | undefined) =>
    ["git", "mutation", "init", resolveExecutionTargetId(executionTargetId), cwd] as const,
  fetch: (cwd: string | null, executionTargetId?: ExecutionTargetId | null | undefined) =>
    ["git", "mutation", "fetch", resolveExecutionTargetId(executionTargetId), cwd] as const,
  discardChanges: (cwd: string | null, executionTargetId?: ExecutionTargetId | null | undefined) =>
    [
      "git",
      "mutation",
      "discard-changes",
      resolveExecutionTargetId(executionTargetId),
      cwd,
    ] as const,
  runStackedAction: (
    cwd: string | null,
    executionTargetId?: ExecutionTargetId | null | undefined,
  ) =>
    [
      "git",
      "mutation",
      "run-stacked-action",
      resolveExecutionTargetId(executionTargetId),
      cwd,
    ] as const,
  pull: (cwd: string | null, executionTargetId?: ExecutionTargetId | null | undefined) =>
    ["git", "mutation", "pull", resolveExecutionTargetId(executionTargetId), cwd] as const,
  preparePullRequestThread: (
    cwd: string | null,
    executionTargetId?: ExecutionTargetId | null | undefined,
  ) =>
    [
      "git",
      "mutation",
      "prepare-pull-request-thread",
      resolveExecutionTargetId(executionTargetId),
      cwd,
    ] as const,
};

export function invalidateGitQueries(
  queryClient: QueryClient,
  input?: { cwd?: string | null; executionTargetId?: ExecutionTargetId | null | undefined },
) {
  const cwd = input?.cwd ?? null;
  if (cwd !== null) {
    const executionTargetKey = resolveExecutionTargetId(input?.executionTargetId);
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: gitQueryKeys.status(cwd, input?.executionTargetId),
      }),
      queryClient.invalidateQueries({
        queryKey: gitQueryKeys.branches(cwd, input?.executionTargetId),
      }),
      queryClient.invalidateQueries({
        queryKey: ["git", "commits", executionTargetKey, cwd],
      }),
      queryClient.invalidateQueries({
        queryKey: ["git", "commit-details", executionTargetKey, cwd],
      }),
      queryClient.invalidateQueries({
        queryKey: ["git", "working-tree-diff", executionTargetKey, cwd],
      }),
    ]);
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

export function invalidateGitStatusQuery(
  queryClient: QueryClient,
  cwd: string | null,
  executionTargetId?: ExecutionTargetId | null | undefined,
) {
  if (cwd === null) {
    return Promise.resolve();
  }

  return queryClient.invalidateQueries({
    queryKey: gitQueryKeys.status(cwd, executionTargetId),
  });
}

export function gitStatusQueryOptions(
  cwd: string | null,
  executionTargetId?: ExecutionTargetId | null | undefined,
) {
  return queryOptions({
    queryKey: gitQueryKeys.status(cwd, executionTargetId),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git status is unavailable.");
      return api.git.refreshStatus({
        cwd,
        ...(executionTargetId ? { executionTargetId } : {}),
      });
    },
    enabled: cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
  });
}

export function gitBranchSearchInfiniteQueryOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  query: string;
  enabled?: boolean;
}) {
  const normalizedQuery = input.query.trim();

  return infiniteQueryOptions({
    queryKey: gitQueryKeys.branchSearch(input.cwd, normalizedQuery, input.executionTargetId),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches({
        cwd: input.cwd,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
        ...(normalizedQuery.length > 0 ? { query: normalizedQuery } : {}),
        cursor: pageParam,
        limit: GIT_BRANCHES_PAGE_SIZE,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: input.cwd !== null && (input.enabled ?? true),
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitListCommitsInfiniteQueryOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  limit?: number;
  enabled?: boolean;
}) {
  const limit = input.limit ?? 50;

  return infiniteQueryOptions({
    queryKey: gitQueryKeys.commits(input.cwd, input.executionTargetId, input.limit),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git history is unavailable.");
      return api.git.listCommits({
        cwd: input.cwd,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
        cursor: pageParam,
        limit,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: input.cwd !== null && (input.enabled ?? true),
    staleTime: GIT_HISTORY_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function gitCommitDetailsQueryOptions(
  input: GitGetCommitDetailsInput & { enabled?: boolean },
) {
  return queryOptions({
    queryKey: gitQueryKeys.commitDetails(input.cwd, input.executionTargetId, input.commit),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.git.getCommitDetails(input);
    },
    enabled: Boolean(input.cwd && input.commit) && (input.enabled ?? true),
    staleTime: GIT_HISTORY_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function gitWorkingTreeDiffQueryOptions(
  input: GitReadWorkingTreeDiffInput & { enabled?: boolean },
) {
  return queryOptions({
    queryKey: gitQueryKeys.workingTreeDiff(input.cwd, input.executionTargetId, input.path ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.git.readWorkingTreeDiff(input);
    },
    enabled: Boolean(input.cwd) && (input.enabled ?? true),
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: [
      "git",
      "pull-request",
      resolveExecutionTargetId(input.executionTargetId),
      input.cwd,
      input.reference,
    ] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return api.git.resolvePullRequest({
        cwd: input.cwd,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
        reference: input.reference,
      });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
