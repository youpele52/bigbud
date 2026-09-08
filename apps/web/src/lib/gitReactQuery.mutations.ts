import {
  type GitActionProgressEvent,
  type GitStackedAction,
  type ThreadId,
  type ExecutionTargetId,
} from "@bigbud/contracts";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "../rpc/nativeApi";
import { getWsRpcClient } from "../rpc/wsRpcClient";
import { randomUUID } from "~/lib/utils";
import { invalidateGitQueries, gitMutationKeys } from "./gitReactQuery";

export type GitMutationVariables = {
  readonly operationId: string;
};

/** Creates one identity for a logical Git mutation before it enters React Query. */
export function createGitMutationOperationId(): string {
  return `git-mutation-${randomUUID()}`;
}

export function gitInitMutationOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd, input.executionTargetId),
    mutationFn: async ({ operationId }: GitMutationVariables) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init({
        cwd: input.cwd,
        operationId,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
      });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient, {
        cwd: input.cwd,
        executionTargetId: input.executionTargetId,
      });
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
      await invalidateGitQueries(input.queryClient, {
        cwd: input.cwd,
        executionTargetId: input.executionTargetId,
      });
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
    mutationFn: async ({ operationId }: GitMutationVariables) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.git.pull({
        cwd: input.cwd,
        operationId,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, {
        cwd: input.cwd,
        executionTargetId: input.executionTargetId,
      });
    },
  });
}

export function gitFetchMutationOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.fetch(input.cwd, input.executionTargetId),
    mutationFn: async ({ operationId }: GitMutationVariables) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git fetch is unavailable.");
      return api.git.fetch({
        cwd: input.cwd,
        operationId,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, {
        cwd: input.cwd,
        executionTargetId: input.executionTargetId,
      });
    },
  });
}

export function gitDiscardChangesMutationOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.discardChanges(input.cwd, input.executionTargetId),
    mutationFn: async ({ operationId }: GitMutationVariables) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Discard changes is unavailable.");
      return api.git.discardChanges({
        cwd: input.cwd,
        operationId,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, {
        cwd: input.cwd,
        executionTargetId: input.executionTargetId,
      });
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
      operationId,
    }: {
      cwd: string;
      executionTargetId?: ExecutionTargetId | null | undefined;
      path: string;
      force?: boolean;
      operationId: string;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      return api.git.removeWorktree({
        cwd,
        operationId,
        ...(executionTargetId ? { executionTargetId } : {}),
        path,
        force,
      });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async (_data, _error, variables) => {
      await invalidateGitQueries(input.queryClient, {
        cwd: variables?.cwd ?? null,
        executionTargetId: variables?.executionTargetId,
      });
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
      operationId,
    }: {
      reference: string;
      mode: "local" | "worktree";
      threadId?: ThreadId;
      operationId: string;
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request thread preparation is unavailable.");
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        operationId,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
        reference,
        mode,
        ...(threadId ? { threadId } : {}),
      });
    },
    mutationKey: gitMutationKeys.preparePullRequestThread(input.cwd, input.executionTargetId),
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, {
        cwd: input.cwd,
        executionTargetId: input.executionTargetId,
      });
    },
  });
}
