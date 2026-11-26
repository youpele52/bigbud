import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "@effect/vitest";
import { Effect, Path } from "effect";
import { expect, vi } from "vitest";

import { activateDevSshOwner } from "../../ssh/sshOwnerDevMode.fixture.ts";
import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { makeGitHelpers } from "./GitCoreExecutor.ts";
import { isInitiatingGitLocal } from "./GitCore.initiatingFence.ts";
import { InitiatingFetchOwner } from "./GitCore.initiatingTransport.ts";
import { makeGitStatusOps } from "./GitStatus.ts";

const exec = promisify(execFile);
// The xcode-select shim at /usr/bin/git can fail on disposable macOS sandboxes.
const GIT = existsSync("/opt/homebrew/bin/git") ? "/opt/homebrew/bin/git" : "/usr/bin/git";
const env = {
  PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec(GIT, args, { cwd, env, timeout: 20_000 })).stdout;
}

async function setupRepo() {
  const root = await mkdtemp(join(tmpdir(), "bigbud-pull-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const other = join(root, "other");
  await git(root, ["init", "--bare", "--template=", "--initial-branch=main", origin]);
  await git(root, ["clone", origin, work]);
  await git(work, ["config", "user.name", "Work"]);
  await git(work, ["config", "user.email", "work@example.test"]);
  await writeFile(join(work, "tracked.txt"), "initial\n");
  await git(work, ["add", "tracked.txt"]);
  await git(work, ["commit", "-qm", "initial"]);
  await git(work, ["push", "-qu", "origin", "main"]);
  await git(root, ["clone", origin, other]);
  await git(other, ["config", "user.name", "Other"]);
  await git(other, ["config", "user.email", "other@example.test"]);
  return { root, origin, work, other };
}

async function advanceRemote({ work, other }: Awaited<ReturnType<typeof setupRepo>>) {
  await writeFile(join(other, "remote.txt"), "remote\n");
  await git(other, ["add", "remote.txt"]);
  await git(other, ["commit", "-qm", "remote"]);
  await git(other, ["push", "-q", "origin", "main"]);
  return { work, other };
}

function harness() {
  const launches: string[][] = [];
  const execute = (input: ExecuteGitInput): Effect.Effect<ExecuteGitResult, GitCommandError> =>
    Effect.tryPromise({
      try: async () => {
        launches.push([...input.args]);
        // Model an SSH remote on a bigbud target: the fetch must go through the owner.
        if (input.args[0] === "remote" && input.args[1] === "get-url") {
          return {
            code: 0,
            stdout: "ssh://u@target.example/srv/origin.git\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        try {
          const result = await exec(GIT, input.args, {
            cwd: input.cwd,
            env,
            timeout: input.timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
          });
          return {
            code: 0,
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return {
            code: typeof failure.code === "number" ? failure.code : 1,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
      },
      catch: (cause) =>
        new GitCommandError({
          operation: input.operation,
          command: "git",
          cwd: input.cwd,
          detail: String(cause),
        }),
    });
  const helpers = makeGitHelpers(execute);
  const fetch = vi.fn(async (operands: { cwd: string; remoteName: string }) => {
    await git(operands.cwd, ["fetch", "--no-tags", operands.remoteName]);
    return "fetched" as const;
  });
  const ops = Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* makeGitStatusOps(helpers, path, "initiating");
  });
  return { fetch, launches, ops };
}

function runPull(harnessed: ReturnType<typeof harness>, cwd: string) {
  return harnessed.ops.pipe(
    Effect.flatMap((ops) => ops.pullCurrentBranch(cwd)),
    Effect.provideService(InitiatingFetchOwner, { fetch: harnessed.fetch }),
    Effect.provide(Path.layer),
  );
}

it.effect("fast-forwards through an owner fetch and an admitted local merge", () =>
  Effect.gen(function* () {
    activateDevSshOwner();
    const repo = yield* Effect.promise(() => setupRepo());
    yield* Effect.promise(() => advanceRemote(repo));
    const harnessed = harness();
    const result = yield* runPull(harnessed, repo.work);
    expect(result).toMatchObject({ status: "pulled", branch: "main" });
    expect(harnessed.fetch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cwd: repo.work, remoteName: "origin", refspecs: [] }),
      expect.any(AbortSignal),
    );
    expect(yield* Effect.promise(() => git(repo.work, ["rev-parse", "HEAD"]))).toBe(
      yield* Effect.promise(() => git(repo.other, ["rev-parse", "HEAD"])),
    );
    // No transport command and no ambient ssh anywhere in the local history.
    expect(harnessed.launches.some((args) => args.includes("ssh"))).toBe(false);
  }),
);

it.effect("refuses a diverged branch after the owner fetch, without merging", () =>
  Effect.gen(function* () {
    activateDevSshOwner();
    const repo = yield* Effect.promise(() => setupRepo());
    yield* Effect.promise(() => advanceRemote(repo));
    yield* Effect.promise(async () => {
      await writeFile(join(repo.work, "local.txt"), "local\n");
      await git(repo.work, ["add", "local.txt"]);
      await git(repo.work, ["commit", "-qm", "local"]);
    });
    const head = yield* Effect.promise(() => git(repo.work, ["rev-parse", "HEAD"]));
    const harnessed = harness();
    const error = yield* Effect.flip(runPull(harnessed, repo.work));
    expect(error.detail).toContain("diverged");
    expect(harnessed.fetch).toHaveBeenCalledTimes(1);
    expect(harnessed.launches.some((args) => args[0] === "merge")).toBe(false);
    expect(yield* Effect.promise(() => git(repo.work, ["rev-parse", "HEAD"]))).toBe(head);
  }),
);

it.effect("refuses a dirty worktree before any owner fetch", () =>
  Effect.gen(function* () {
    activateDevSshOwner();
    const repo = yield* Effect.promise(() => setupRepo());
    yield* Effect.promise(() => writeFile(join(repo.work, "tracked.txt"), "dirty\n"));
    const harnessed = harness();
    const error = yield* Effect.flip(runPull(harnessed, repo.work));
    expect(error.detail).toContain("uncommitted");
    expect(harnessed.fetch).not.toHaveBeenCalled();
  }),
);

it("refuses pull --rebase and non-fast-forward merges at the fence", () => {
  expect(isInitiatingGitLocal(["merge", "--ff-only", "origin/main"])).toBe(true);
  expect(isInitiatingGitLocal(["merge", "--no-ff", "origin/main"])).toBe(false);
  expect(isInitiatingGitLocal(["pull", "--rebase"])).toBe(false);
});
