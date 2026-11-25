import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect, vi } from "vitest";

import { RemoteAgentGitExecutorService } from "../../remote-agent/remoteAgentGit.ts";
import { activateDevSshOwner } from "../../ssh/sshOwnerDevMode.ts";
import { GitCore } from "../Services/GitCore.ts";
import { makeGitCoreLayerLive } from "./GitComposition.ts";
import { InitiatingFetchOwner } from "./GitCore.initiatingTransport.ts";
import { initiatingGitOwnerUnavailable } from "./GitCore.initiatingFence.ts";
import {
  GitCoreDependenciesLayer,
  initRepoWithCommit,
  makeTmpDir,
} from "./GitCore.test.helpers.ts";

// Use the production GitCore composition and wrap the real spawner. The recorder refuses any
// unexpected command before delegation; fixture setup uses only local Git operations.
function provideGit<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const commands: ChildProcess.StandardCommand[] = [];
  const remote = vi.fn(() => Effect.die("unexpected remote target execution"));
  const recordingSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(Effect.service(ChildProcessSpawner.ChildProcessSpawner), ({ spawn }) =>
      ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command) || command.command !== "git") {
          return Effect.die("unexpected process");
        }
        commands.push(command);
        if (
          ["fetch", "pull", "push", "clone", "ls-remote", "update"].some((arg) =>
            command.args.includes(arg),
          )
        ) {
          return Effect.die("unexpected transport command");
        }
        return spawn(command);
      }),
    ),
  );
  const gitLayer = makeGitCoreLayerLive(Layer.succeed(RemoteAgentGitExecutorService, remote)).pipe(
    Layer.provide(recordingSpawner),
    Layer.provideMerge(GitCoreDependenciesLayer),
  );
  return { commands, remote, effect: effect.pipe(Effect.provide(gitLayer)) };
}

it.effect("rejects unowned initiating transports before the Git spawner", () => {
  activateDevSshOwner();
  const cwd = "/code";
  const fixture = provideGit(
    Effect.gen(function* () {
      const git = yield* GitCore;
      const execute = (args: string[]) =>
        git.execute({
          operation: "GitCore.statusDetailsLocal.status",
          cwd,
          args,
          allowNonZeroExit: true,
        });
      for (const operation of [
        execute(["fetch", "https://example.invalid/project.git"]),
        execute(["--git-dir", "/code/.git", "fetch", "origin"]),
        execute(["--no-lazy-fetch", "fetch"]),
        execute(["remote", "update"]),
        execute(["remote", "show", "origin"]),
        execute(["ls-remote", "origin"]),
        execute(["clone", "origin"]),
        execute(["pull", "--rebase"]),
        execute(["merge", "--no-ff", "origin/main"]),
        execute(["unknown-command"]),
        git.fetch(cwd),
        git.pullCurrentBranch(cwd),
        git.pushCurrentBranch(cwd, null),
        git.fetchPullRequestBranch({ cwd, prNumber: 1, branch: "pr-1" }),
        git.fetchRemoteBranch({
          cwd,
          remoteName: "origin",
          remoteBranch: "main",
          localBranch: "pr-1",
        }),
      ]) {
        expect(yield* Effect.flip(operation)).toMatchObject({
          _tag: "GitCommandError",
          detail: initiatingGitOwnerUnavailable,
        });
      }
    }),
  );
  return fixture.effect.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(fixture.commands).toEqual([]);
        expect(fixture.remote).not.toHaveBeenCalled();
      }),
    ),
  );
});

it.effect("keeps a stale custom upstream ref unchanged in selected status", () => {
  activateDevSshOwner();
  const fixture = provideGit(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const git = yield* GitCore;
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const execute = (args: string[]) => git.execute({ operation: "fixture", cwd, args });
      const trackingRef = "refs/remotes/mirror/snapshot";
      const sourceRef = "refs/heads/published";
      const initialOid = (yield* execute(["rev-parse", "HEAD"])).stdout.trim();
      // A self-remote supplies a real newer source ref without a network, fetch, or push
      // during setup. None of the three upstream names can be inferred from another.
      yield* execute(["checkout", "-b", "published"]);
      yield* execute(["commit", "--allow-empty", "-m", "advance published source"]);
      expect((yield* execute(["rev-parse", sourceRef])).stdout.trim()).not.toBe(initialOid);
      yield* execute(["checkout", initialBranch]);
      yield* execute(["config", "remote.team/upstream.url", cwd]);
      yield* execute(["config", "remote.team/upstream.fetch", `+${sourceRef}:${trackingRef}`]);
      yield* execute(["config", `branch.${initialBranch}.remote`, "team/upstream"]);
      yield* execute(["config", `branch.${initialBranch}.merge`, sourceRef]);
      yield* execute(["update-ref", trackingRef, initialOid]);
      expect(yield* git.listWorkspaceFiles(cwd)).toMatchObject({ paths: ["README.md"] });
      expect(yield* git.filterIgnoredPaths(cwd, ["README.md"])).toEqual(["README.md"]);
      expect(yield* git.statusDetails(cwd)).toMatchObject({
        branch: initialBranch,
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        upstreamRef: "mirror/snapshot",
      });
      expect((yield* execute(["rev-parse", trackingRef])).stdout.trim()).toBe(initialOid);
    }),
  );
  return fixture.effect.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const commands = fixture.commands;
        expect(commands.some(({ args }) => args[0] === "status")).toBe(true);
        expect(
          commands.some(
            ({ args }) => args.includes("@{upstream}") || args.includes("--git-common-dir"),
          ),
        ).toBe(false);
        expect(
          commands.every(
            ({ options }) =>
              options.env?.GIT_NO_LAZY_FETCH === "1" && options.env?.GIT_ALLOW_PROTOCOL === "",
          ),
        ).toBe(true);
        expect(fixture.remote).not.toHaveBeenCalled();
      }),
    ),
  );
});

it.effect(
  "routes selected initiated fetch through the owner transport with no legacy launch",
  () => {
    activateDevSshOwner();
    const fetch = vi.fn(async () => "fetched" as const);
    const fixture = provideGit(
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const git = yield* GitCore;
        const execute = (args: string[]) => git.execute({ operation: "fixture", cwd, args });
        yield* execute(["remote", "add", "origin", "ssh://git@example.invalid/project.git"]);
        expect(yield* git.fetch(cwd)).toEqual({ status: "fetched" });
        return cwd;
      }).pipe(Effect.provideService(InitiatingFetchOwner, { fetch })),
    );
    return fixture.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(fetch).toHaveBeenCalledExactlyOnceWith(
            { cwd: expect.any(String), remoteName: "origin", refspecs: [], timeoutMs: 30_000 },
            expect.any(AbortSignal),
          );
          // The recording spawner dies on any fetch transport; reaching here proves none ran.
          expect(fixture.commands.some(({ args }) => args.includes("fetch"))).toBe(false);
          expect(fixture.remote).not.toHaveBeenCalled();
        }),
      ),
    );
  },
);
