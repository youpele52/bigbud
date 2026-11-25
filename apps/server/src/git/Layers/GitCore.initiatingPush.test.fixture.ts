import { realpath } from "node:fs/promises";
import path from "node:path";
import { Effect, Result } from "effect";
import { expect, vi } from "vitest";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import { GitCore, type ExecuteGitInput } from "../Services/GitCore.ts";
import type { ApprovedInitiatingGitPush } from "../Services/InitiatingGitOwner.ts";
import { git, makeIsolatedGitCoreWithRemote, makeTmpDir } from "./GitCore.test.helpers.ts";

export const effective = "ssh://git@push.invalid:2222/group/project.git";
export const remoteName = "team/origin";

export const setup = Effect.fn("setupInitiatingPushTest")(function* () {
  const cwd = yield* makeTmpDir();
  yield* git(cwd, ["init", "--initial-branch=local"]);
  yield* git(cwd, ["config", "user.email", "fixture@example.invalid"]);
  yield* git(cwd, ["config", "user.name", "Fixture"]);
  const tree = yield* git(cwd, ["write-tree"]);
  const sourceOid = yield* git(cwd, ["commit-tree", tree, "-m", "fixture"]);
  yield* git(cwd, ["update-ref", "refs/heads/local", sourceOid]);
  yield* git(cwd, ["remote", "add", remoteName, "https://read.invalid/group/project.git"]);
  yield* git(cwd, ["config", `remote.${remoteName}.pushurl`, "fixture-push:group/project.git"]);
  yield* git(cwd, ["config", "url.ssh://git@push.invalid:2222/.insteadOf", "fixture-push:"]);
  yield* git(cwd, ["config", "branch.local.remote", remoteName]);
  yield* git(cwd, ["config", "branch.local.merge", "refs/heads/tracked"]);
  yield* git(cwd, ["update-ref", `refs/remotes/${remoteName}/tracked`, sourceOid]);
  const worktree = yield* Effect.promise(() => realpath(cwd));
  const approvedPush = {
    direction: "push",
    executionTargetId: "ssh:host=push.invalid&user=git&port=2222",
    targetGeneration: "test-generation",
    repository: {
      worktree,
      gitDir: path.join(worktree, ".git"),
      commonDir: path.join(worktree, ".git"),
    },
    remoteName,
    destination: {
      host: "push.invalid",
      user: "git",
      port: 2222,
      repositoryPath: "/group/project.git",
    },
    refs: { source: "refs/heads/local", destination: "refs/heads/tracked" },
  } satisfies ApprovedInitiatingGitPush;

  const actual = yield* GitCore;
  const local = vi.fn((input: ExecuteGitInput) =>
    isLocalProbe(input) ? actual.execute(input) : Effect.fail(blocked(input)),
  );
  const remote = vi.fn((input: ExecuteGitInput) => Effect.fail(blocked(input)));
  const core = yield* makeIsolatedGitCoreWithRemote({ execute: local, remoteExecute: remote });
  return { cwd, core, approvedPush, sourceOid, local, remote };
});

export function isLocalProbe({ args: [flag, command, subcommand] }: ExecuteGitInput): boolean {
  return (
    flag === "--no-lazy-fetch" &&
    (command === "rev-parse" ||
      command === "symbolic-ref" ||
      command === "check-ref-format" ||
      (command === "config" && subcommand === "--null") ||
      (command === "remote" && subcommand === "get-url"))
  );
}

function blocked(input: ExecuteGitInput) {
  return new GitCommandError({
    operation: input.operation,
    cwd: input.cwd,
    command: "blocked",
    detail: "Fixture forbids legacy commands.",
  });
}

export const expectDenied = <A>(result: Result.Result<A, GitCommandError>, detail: string) => {
  expect(Result.isFailure(result) && result.failure.detail).toContain(detail);
};
