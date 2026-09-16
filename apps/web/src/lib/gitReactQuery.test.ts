import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("../rpc/nativeApi", () => ({
  ensureNativeApi: vi.fn(),
}));

vi.mock("../rpc/wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));

import type { InfiniteData } from "@tanstack/react-query";
import type { GitListBranchesResult, GitListCommitsResult } from "@bigbud/contracts";

import {
  createGitMutationOperationId,
  gitBranchSearchInfiniteQueryOptions,
  gitListCommitsInfiniteQueryOptions,
  gitMutationKeys,
  gitQueryKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  invalidateGitStatusQuery,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "./gitReactQuery";
import { ensureNativeApi } from "../rpc/nativeApi";

const BRANCH_QUERY_RESULT: GitListBranchesResult = {
  branches: [],
  isRepo: true,
  hasOriginRemote: true,
  nextCursor: null,
  totalCount: 0,
};

const BRANCH_SEARCH_RESULT: InfiniteData<GitListBranchesResult, number> = {
  pages: [BRANCH_QUERY_RESULT],
  pageParams: [0],
};

const COMMITS_QUERY_RESULT: GitListCommitsResult = {
  commits: [],
  nextCursor: null,
};

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });

  it("reuses one operation id when a pull response is lost and the mutation retries", async () => {
    const pull = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({
      status: "skipped_up_to_date",
      branch: "main",
      upstreamBranch: "origin/main",
    });
    const api = { git: { pull } } as unknown as ReturnType<typeof ensureNativeApi>;
    vi.mocked(ensureNativeApi).mockReturnValue(api);
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    if (!options.mutationFn) throw new Error("Expected a Git pull mutation function.");
    const variables = { operationId: "git-retry-1" };
    const mutationContext = {} as Parameters<NonNullable<typeof options.mutationFn>>[1];

    await expect(options.mutationFn(variables, mutationContext)).rejects.toThrow("response lost");
    await expect(options.mutationFn(variables, mutationContext)).resolves.toMatchObject({
      status: "skipped_up_to_date",
    });

    expect(pull).toHaveBeenNthCalledWith(1, expect.objectContaining(variables));
    expect(pull).toHaveBeenNthCalledWith(2, expect.objectContaining(variables));
    expect(createGitMutationOperationId()).not.toBe(createGitMutationOperationId());
  });
});

describe("invalidateGitQueries", () => {
  it("can invalidate a single cwd without blasting other git query scopes", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "a" });
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        cwd: "/repo/a",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        cwd: "/repo/b",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );
    queryClient.setQueryData(
      gitListCommitsInfiniteQueryOptions({
        cwd: "/repo/a",
        limit: 20,
      }).queryKey,
      { pages: [COMMITS_QUERY_RESULT], pageParams: [0] },
    );
    queryClient.setQueryData(
      gitListCommitsInfiniteQueryOptions({
        cwd: "/repo/b",
        limit: 20,
      }).queryKey,
      { pages: [COMMITS_QUERY_RESULT], pageParams: [0] },
    );

    await invalidateGitQueries(queryClient, { cwd: "/repo/a" });

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          cwd: "/repo/a",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          cwd: "/repo/b",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(
        gitListCommitsInfiniteQueryOptions({
          cwd: "/repo/a",
          limit: 20,
        }).queryKey,
      )?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        gitListCommitsInfiniteQueryOptions({
          cwd: "/repo/b",
          limit: 20,
        }).queryKey,
      )?.isInvalidated,
    ).toBe(false);
  });
});

describe("invalidateGitStatusQuery", () => {
  it("invalidates only status for the selected cwd", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "a" });
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });

    await invalidateGitStatusQuery(queryClient, "/repo/a");

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
  });

  it("invalidates the selected remote target instead of the local target", async () => {
    const queryClient = new QueryClient();
    const remoteTarget = "ssh:example";

    queryClient.setQueryData(gitQueryKeys.status("/repo/a", remoteTarget), {
      ok: "remote",
    });
    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "local" });

    await invalidateGitStatusQuery(queryClient, "/repo/a", remoteTarget);

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a", remoteTarget).queryKey)
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(false);
  });
});
