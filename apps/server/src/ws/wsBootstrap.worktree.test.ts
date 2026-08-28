import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ensureBootstrapWorktree } from "./wsBootstrap.worktree.ts";

const branchResult = (worktreePath: string) => ({
  branches: [
    {
      name: "feature/existing",
      current: false,
      isDefault: false,
      worktreePath,
    },
  ],
  isRepo: true,
  hasOriginRemote: false,
  nextCursor: null,
  totalCount: 1,
});

const createInput = {
  cwd: "/repo/project",
  branch: "feature/existing",
  path: "/managed/bootstrap-command",
} as const;

describe("ensureBootstrapWorktree exact-path reconciliation", () => {
  it("adopts only the registered worktree at the command-owned path", async () => {
    const createWorktree = vi.fn(() => Effect.die("must not recreate"));
    const result = await Effect.runPromise(
      ensureBootstrapWorktree({
        git: {
          createWorktree,
          listBranches: () => Effect.succeed(branchResult("/canonical/bootstrap-command")),
        } as never,
        branch: "feature/existing",
        createInput,
        expectedPath: createInput.path,
        canonicalizePath: (candidate) =>
          Effect.succeed(candidate.replace("/managed/", "/canonical/")),
      }),
    );

    expect(result.worktree.path).toBe("/canonical/bootstrap-command");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("preserves the create error when the same branch belongs to another path", async () => {
    const createError = new Error("branch is checked out elsewhere");
    const createWorktree = vi.fn(() => Effect.fail(createError as never));
    await expect(
      Effect.runPromise(
        ensureBootstrapWorktree({
          git: {
            createWorktree,
            listBranches: () => Effect.succeed(branchResult("/repo/project")),
          } as never,
          branch: "feature/existing",
          createInput,
          expectedPath: createInput.path,
          canonicalizePath: (candidate) => Effect.succeed(candidate),
        }),
      ),
    ).rejects.toBe(createError);
    expect(createWorktree).toHaveBeenCalledOnce();
  });
});
