import {
  resolveExecutionTargetId,
  type ExecutionTargetId,
  type GitActionProgressEvent,
  type GitStackedAction,
  type ThreadId,
} from "@bigbud/contracts";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ensureNativeApi } from "../rpc/nativeApi";
import { getWsRpcClient } from "../rpc/wsRpcClient";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;
const GIT_BRANCHES_PAGE_SIZE = 100;

export const gitQueryKeys = {
  all: ["git"] as const,
  status: (cwd: string | null, executionTargetId?: ExecutionTargetId | null | undefined) =>
    ["git", "status", resolveExecutionTargetId(executionTargetId), cwd] as const,
  branches: (cwd: string | null, executionTargetId?: ExecutionTargetId | null | undefined) =>
    ["git", "branches", resolveExecutionTargetId(executionTargetId), cwd] as const,
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
  checkout: (cwd: string | null, executionTargetId?: ExecutionTargetId | null | undefined) =>
    ["git", "mutation", "checkout", resolveExecutionTargetId(executionTargetId), cwd] as const,
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
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: gitQueryKeys.status(cwd, input?.executionTargetId),
      }),
      queryClient.invalidateQueries({
        queryKey: gitQueryKeys.branches(cwd, input?.executionTargetId),
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

export function gitInitMutationOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd, input.executionTargetId),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init({
        cwd: input.cwd,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
      });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.cwd, input.executionTargetId),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git checkout is unavailable.");
      return api.git.checkout({
        cwd: input.cwd,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
        branch,
      });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.cwd, input.executionTargetId),
    mutationFn: async ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
      onProgress,
    }: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      if (!input.cwd) throw new Error("Git action is unavailable.");
      return getWsRpcClient().git.runStackedAction(
        {
          actionId,
          cwd: input.cwd,
          ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
          action,
          ...(commitMessage ? { commitMessage } : {}),
          ...(featureBranch ? { featureBranch } : {}),
          ...(filePaths ? { filePaths } : {}),
        },
        ...(onProgress ? [{ onProgress }] : []),
      );
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPullMutationOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.cwd, input.executionTargetId),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.git.pull({
        cwd: input.cwd,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      executionTargetId,
      branch,
      newBranch,
      path,
    }: {
      cwd: string;
      executionTargetId?: ExecutionTargetId | null | undefined;
      branch: string;
      newBranch: string;
      path?: string | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      return api.git.createWorktree({
        cwd,
        ...(executionTargetId ? { executionTargetId } : {}),
        branch,
        newBranch,
        path: path ?? null,
      });
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      executionTargetId,
      path,
      force,
    }: {
      cwd: string;
      executionTargetId?: ExecutionTargetId | null | undefined;
      path: string;
      force?: boolean;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      return api.git.removeWorktree({
        cwd,
        ...(executionTargetId ? { executionTargetId } : {}),
        path,
        force,
      });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({
      reference,
      mode,
      threadId,
    }: {
      reference: string;
      mode: "local" | "worktree";
      threadId?: ThreadId;
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request thread preparation is unavailable.");
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
        reference,
        mode,
        ...(threadId ? { threadId } : {}),
      });
    },
    mutationKey: gitMutationKeys.preparePullRequestThread(input.cwd, input.executionTargetId),
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}
