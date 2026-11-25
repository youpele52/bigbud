import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { expect } from "vitest";

import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import {
  git,
  GitCoreDependenciesLayer,
  initRepoWithCommit,
  makeTmpDir,
} from "./GitCore.test.helpers.ts";
import { GitCoreLive } from "./GitCore.ts";
import { GitHubCliLive } from "./GitHubCli.ts";
import { makeGitManager } from "./GitManager.ts";

const prRef = "refs/pull/64/head";
const headBranch = "feature/fixture";
const forkSshUrl = "git@fork.invalid:fork/project.git";
const prFields =
  "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner";

// The checkout recipe is deliberately chosen by this recorder, not by real gh.
// Only file transport is available to the real Git subprocesses.
const recordCall = `{
  printf '%s\\t%s' "$ACTOR" "$PWD"
  printf '\\t%s' "$@"
  printf '\\n'
} >> "$FIXTURE_LOG"`;

const ghRecorder = `#!/bin/sh
set -eu
ACTOR=gh
${recordCall}
case "$*" in
  'pr view 64 --json ${prFields}')
    printf '%s\\n' '${JSON.stringify({
      number: 64,
      title: "Fixture PR",
      url: "https://example.invalid/base/project/pull/64",
      baseRefName: "main",
      headRefName: headBranch,
      state: "OPEN",
      mergedAt: null,
      isCrossRepository: true,
      headRepository: { nameWithOwner: "fork/project" },
      headRepositoryOwner: { login: "fork" },
    })}' ;;
  'pr checkout 64 --force')
    if [ "$FIXTURE_CHECKOUT_FAIL" = 1 ]; then
      printf '%s\\n' 'fixture checkout refused' >&2
      exit 19
    fi
    export FIXTURE_GH_DESCENDANT=1
    git fetch --quiet "$FIXTURE_BARE" '${prRef}'
    git checkout --quiet -B '${headBranch}' --no-track FETCH_HEAD
    git update-ref 'refs/remotes/fork/${headBranch}' FETCH_HEAD ;;
  'repo view fork/project --json nameWithOwner,url,sshUrl')
    printf '%s\\n' '${JSON.stringify({
      nameWithOwner: "fork/project",
      url: "https://fork.invalid/fork/project",
      sshUrl: forkSshUrl,
    })}' ;;
  *) exit 98 ;;
esac
`;

const gitRecorder = `#!/bin/sh
set -eu
ACTOR=git
if [ "\${FIXTURE_GH_DESCENDANT-}" = 1 ]; then ACTOR=gh:git; fi
${recordCall}
exec /usr/bin/git "$@"
`;

const unexpectedCall = () => Effect.die("Unexpected setup or text generation");
const TestLayer = Layer.mergeAll(
  GitCoreLive,
  GitHubCliLive,
  ServerSettingsService.layerTest({}),
  Layer.succeed(ProjectSetupScriptRunner, { runForThread: unexpectedCall }),
  Layer.succeed(TextGeneration, {
    generateCommitMessage: unexpectedCall,
    generatePrContent: unexpectedCall,
    generateBranchName: unexpectedCall,
    generateThreadTitle: unexpectedCall,
    generateThreadElevatorSummary: unexpectedCall,
    generatePromptSuggestion: unexpectedCall,
  }),
).pipe(Layer.provideMerge(GitCoreDependenciesLayer));

it.layer(TestLayer)("local PR delegation (v0.4.0 call shape)", (it) => {
  for (const checkoutFails of [false, true]) {
    it.effect.skipIf(process.platform === "win32")(
      checkoutFails
        ? "surfaces the recorder checkout failure without a direct Git fallback"
        : "spawns gh in the repository before applying the fork upstream configuration",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.realPath(yield* makeTmpDir("git-gh-baseline-"));
          const bin = path.join(root, "bin");
          const source = path.join(root, "source");
          const workspace = path.join(root, "workspace");
          const bare = path.join(root, "fixture.git");
          const log = path.join(root, "processes.log");
          const templates = path.join(root, "templates");
          yield* fs.makeDirectory(bin);
          yield* fs.makeDirectory(source);
          yield* fs.makeDirectory(templates);
          yield* fs.writeFileString(path.join(bin, "gh"), ghRecorder, { mode: 0o700 });
          yield* fs.writeFileString(path.join(bin, "git"), gitRecorder, { mode: 0o700 });

          // GitHubCliLive inherits the parent environment. Replace rather than merge
          // it in this serial test so neither child sees ambient credentials/config.
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = process.env;
              process.env = {
                PATH: bin,
                HOME: root,
                XDG_CONFIG_HOME: root,
                GH_CONFIG_DIR: root,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: path.join(root, "empty.gitconfig"),
                GIT_TEMPLATE_DIR: templates,
                GIT_ALLOW_PROTOCOL: "file",
                FIXTURE_LOG: log,
                FIXTURE_BARE: bare,
                FIXTURE_CHECKOUT_FAIL: checkoutFails ? "1" : "0",
              };
              return previous;
            }),
            (previous) =>
              Effect.sync(() => {
                process.env = previous;
              }),
          );

          const manager = yield* makeGitManager();
          const { initialBranch } = yield* initRepoWithCommit(source);
          const initial = yield* git(source, ["rev-parse", "HEAD"]);
          yield* git(source, ["clone", "--", source, workspace]);
          yield* git(workspace, ["branch", headBranch]);
          yield* git(workspace, [
            "remote",
            "set-url",
            "origin",
            "git@base.invalid:base/project.git",
          ]);
          yield* git(source, ["commit", "--allow-empty", "-m", "Fixture PR tip"]);
          const prTip = yield* git(source, ["rev-parse", "HEAD"]);
          yield* git(source, ["clone", "--bare", "--", source, bare]);
          yield* git(bare, ["update-ref", prRef, prTip]);
          yield* fs.writeFileString(log, "");

          const result = yield* Effect.result(
            manager.preparePullRequestThread({
              cwd: workspace,
              reference: "#64",
              mode: "local",
            }),
          );
          const calls = (yield* fs.readFileString(log))
            .trimEnd()
            .split("\n")
            .map((line) => line.split("\t"));
          const delegated = calls.filter(([actor]) => actor === "gh" || actor === "gh:git");
          const metadataAndCheckout = [
            ["gh", workspace, "pr", "view", "64", "--json", prFields],
            ["gh", workspace, "pr", "checkout", "64", "--force"],
          ];

          if (checkoutFails) {
            if (result._tag !== "Failure") throw new Error("Expected checkout to fail");
            expect(result.failure.message).toContain("fixture checkout refused");
            expect(calls).toEqual(metadataAndCheckout);
            expect(yield* git(workspace, ["branch", "--show-current"])).toBe(initialBranch);
            expect(yield* git(workspace, ["rev-parse", headBranch])).toBe(initial);
            return;
          }

          if (result._tag !== "Success") throw result.failure;
          expect(result.success).toMatchObject({ branch: headBranch, worktreePath: null });
          expect(delegated).toEqual([
            ...metadataAndCheckout,
            ["gh:git", workspace, "fetch", "--quiet", bare, prRef],
            [
              "gh:git",
              workspace,
              "checkout",
              "--quiet",
              "-B",
              headBranch,
              "--no-track",
              "FETCH_HEAD",
            ],
            ["gh:git", workspace, "update-ref", `refs/remotes/fork/${headBranch}`, "FETCH_HEAD"],
            ["gh", workspace, "repo", "view", "fork/project", "--json", "nameWithOwner,url,sshUrl"],
          ]);
          expect(
            calls.filter(
              ([actor, , op]) =>
                actor === "git" && ["fetch", "pull", "push", "worktree"].includes(op ?? ""),
            ),
          ).toEqual([]);
          expect(yield* git(workspace, ["rev-parse", "HEAD", headBranch])).toBe(
            `${prTip}\n${prTip}`,
          );
          expect(yield* git(workspace, ["config", "--get", "remote.fork.url"])).toBe(forkSshUrl);
          expect(yield* git(workspace, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            `fork/${headBranch}`,
          );
        }),
    );
  }
});
