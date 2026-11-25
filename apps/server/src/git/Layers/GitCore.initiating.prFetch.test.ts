import { it } from "@effect/vitest";
import { Effect, Path } from "effect";
import { expect, vi } from "vitest";

import { activateDevSshOwner } from "../../ssh/sshOwnerDevMode.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { makeGitHelpers } from "./GitCoreExecutor.ts";
import { InitiatingFetchOwner } from "./GitCore.initiatingTransport.ts";
import { makeGitWorktreeOps } from "./GitWorktree.ts";

const success: ExecuteGitResult = {
  code: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};
const cwd = "/srv/repo";

function harness() {
  const calls: string[][] = [];
  const execute = (input: ExecuteGitInput): Effect.Effect<ExecuteGitResult> => {
    calls.push([...input.args]);
    return Effect.succeed(success);
  };
  const helpers = makeGitHelpers(execute);
  const fetch = vi.fn(async () => "fetched" as const);
  const statusOps = {
    branchExists: () => Effect.succeed(false),
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
  };
  const ops = Effect.gen(function* () {
    const path = yield* Path.Path;
    return makeGitWorktreeOps(helpers, statusOps, path, "/unused", "initiating");
  });
  return { calls, fetch, ops };
}

it.effect("fetches a pull request head through the owner with the exact refspec", () =>
  Effect.gen(function* () {
    activateDevSshOwner();
    const { calls, fetch, ops } = harness();
    yield* ops.pipe(
      Effect.flatMap((worktree) =>
        worktree.fetchPullRequestBranch({ cwd, prNumber: 42, branch: "pr-42" }),
      ),
      Effect.provide(Path.layer),
      Effect.provideService(InitiatingFetchOwner, { fetch }),
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      {
        cwd,
        remoteName: "origin",
        refspecs: ["+refs/pull/42/head:refs/heads/pr-42"],
        timeoutMs: 30_000,
      },
      expect.any(AbortSignal),
    );
    expect(calls.some((args) => args[0] === "fetch")).toBe(false);
  }),
);

it.effect("fetches a remote branch and materializes the local branch", () =>
  Effect.gen(function* () {
    activateDevSshOwner();
    const { calls, fetch, ops } = harness();
    yield* ops.pipe(
      Effect.flatMap((worktree) =>
        worktree.fetchRemoteBranch({
          cwd,
          remoteName: "origin",
          remoteBranch: "feature",
          localBranch: "feature",
        }),
      ),
      Effect.provide(Path.layer),
      Effect.provideService(InitiatingFetchOwner, { fetch }),
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      {
        cwd,
        remoteName: "origin",
        refspecs: ["+refs/heads/feature:refs/remotes/origin/feature"],
        timeoutMs: 30_000,
      },
      expect.any(AbortSignal),
    );
    expect(calls).toContainEqual(["branch", "feature", "origin/feature"]);
    expect(calls.some((args) => args[0] === "fetch")).toBe(false);
  }),
);

it.effect("refuses invalid PR operands before the owner or a legacy fetch", () =>
  Effect.gen(function* () {
    activateDevSshOwner();
    const { calls, fetch, ops } = harness();
    for (const prNumber of [0, -1, 1.5, Number.NaN]) {
      const error = yield* ops.pipe(
        Effect.flatMap((worktree) =>
          Effect.flip(worktree.fetchPullRequestBranch({ cwd, prNumber, branch: "pr" })),
        ),
        Effect.provide(Path.layer),
      );
      expect(error).toMatchObject({ _tag: "GitCommandError" });
    }
    const badBranch = yield* ops.pipe(
      Effect.flatMap((worktree) =>
        Effect.flip(worktree.fetchPullRequestBranch({ cwd, prNumber: 1, branch: "../escape" })),
      ),
      Effect.provide(Path.layer),
      Effect.provideService(InitiatingFetchOwner, { fetch }),
    );
    expect(badBranch).toMatchObject({ _tag: "GitCommandError" });
    expect(badBranch.detail).toContain("No ambient transport was started");
    expect(fetch).not.toHaveBeenCalled();
    expect(calls.some((args) => args[0] === "fetch")).toBe(false);
  }),
);

it.effect("refuses an unsafe remote branch refspec before the owner", () =>
  Effect.gen(function* () {
    activateDevSshOwner();
    const { fetch, ops } = harness();
    const error = yield* ops.pipe(
      Effect.flatMap((worktree) =>
        Effect.flip(
          worktree.fetchRemoteBranch({
            cwd,
            remoteName: "origin",
            remoteBranch: "../../main",
            localBranch: "feature",
          }),
        ),
      ),
      Effect.provide(Path.layer),
      Effect.provideService(InitiatingFetchOwner, { fetch }),
    );
    expect(error).toMatchObject({ _tag: "GitCommandError" });
    expect(fetch).not.toHaveBeenCalled();
  }),
);
