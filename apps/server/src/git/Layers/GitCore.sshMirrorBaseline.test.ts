import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect } from "vitest";

import { GitCore } from "../Services/GitCore.ts";
import {
  git,
  initRepoWithCommit,
  makeIsolatedGitCore,
  makeTmpDir,
  TestLayer,
} from "./GitCore.test.helpers.ts";

const pushOperation = "GitCore.pushCurrentBranch.pushUpstream";
const refusal = "fixture mirror transport refused";

// Git's SSH executable is replaced entirely; only fixed synthetic endpoints
// are accepted and the remote command is matched as text, never executed.
const sshRecorder = `#!/bin/sh
set -eu
if [ "\${1-}" = -o ] && [ "\${2-}" = SendEnv=GIT_PROTOCOL ]; then
  shift 2
fi
[ "$#" -eq 2 ] || exit 97
printf '%s\\t%s\\t%s\\n' "$FIXTURE_GIT_OPERATION" "$1" "$2" >> "$FIXTURE_SSH_LOG"
case "$1:$2" in
  "git@primary.invalid:git-receive-pack '/primary.git'")
    exec git receive-pack "$FIXTURE_PRIMARY_REPO" ;;
  "git@mirror.invalid:git-receive-pack '/mirror.git'")
    primary_tip=$(git --git-dir="$FIXTURE_PRIMARY_REPO" rev-parse --verify HEAD)
    printf 'primary tip at mirror attempt\\t%s\\n' "$primary_tip" >> "$FIXTURE_SSH_LOG"
    printf '%s\\n' '${refusal}' >&2
    exit 19 ;;
  *) exit 98 ;;
esac
`;

it.layer(TestLayer)("GitCore local SSH multi-destination push (v0.4.0 call shape)", (it) => {
  it.effect.skipIf(process.platform === "win32")(
    "reports failure after the first push destination has accepted the ref update",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const realCore = yield* GitCore;
        const root = yield* makeTmpDir("git-ssh-mirror-baseline-");
        const source = path.join(root, "source");
        const workspace = path.join(root, "workspace");
        const primary = path.join(root, "primary.git");
        const mirror = path.join(root, "mirror.git");
        const recorder = path.join(root, "ssh-recorder");
        const log = path.join(root, "ssh.log");
        const templates = path.join(root, "templates");
        yield* fs.makeDirectory(source);
        yield* fs.makeDirectory(templates);
        yield* fs.writeFileString(recorder, sshRecorder, { mode: 0o700 });
        yield* fs.writeFileString(log, "");

        const clearedGitEnv = Object.fromEntries(
          Object.keys(process.env)
            .filter(
              (key) => key.startsWith("GIT_") || key.startsWith("GH_") || key.startsWith("GITHUB_"),
            )
            .map((key) => [key, undefined]),
        );
        const core = yield* makeIsolatedGitCore((input) =>
          realCore.execute({
            ...input,
            env: {
              ...input.env,
              ...clearedGitEnv,
              HOME: root,
              XDG_CONFIG_HOME: root,
              GIT_CONFIG_GLOBAL: path.join(root, "empty.gitconfig"),
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_TEMPLATE_DIR: templates,
              GIT_ALLOW_PROTOCOL: "file:ssh",
              GIT_SSH: recorder,
              GIT_SSH_VARIANT: "ssh",
              FIXTURE_SSH_LOG: log,
              FIXTURE_PRIMARY_REPO: primary,
              FIXTURE_GIT_OPERATION: input.operation,
            },
          }),
        );

        yield* Effect.gen(function* () {
          const { initialBranch } = yield* initRepoWithCommit(source);
          const branchRef = `refs/heads/${initialBranch}`;
          const initialTip = yield* git(source, ["rev-parse", "HEAD"]);
          yield* git(source, ["clone", "--bare", source, primary]);
          yield* git(source, ["clone", "--bare", source, mirror]);
          // Status preflight fetches from this local source, not the push URLs.
          yield* git(source, ["clone", source, workspace]);
          yield* git(workspace, ["config", "user.name", "Test"]);
          yield* git(workspace, ["config", "user.email", "test@test.com"]);
          yield* git(workspace, [
            "config",
            "--add",
            "remote.origin.pushurl",
            "ssh://git@primary.invalid/primary.git",
          ]);
          yield* git(workspace, [
            "config",
            "--add",
            "remote.origin.pushurl",
            "ssh://git@mirror.invalid/mirror.git",
          ]);
          yield* git(workspace, ["commit", "--allow-empty", "-m", "new local tip"]);
          const newTip = yield* git(workspace, ["rev-parse", "HEAD"]);
          expect(newTip).not.toBe(initialTip);
          expect(yield* git(primary, ["rev-parse", branchRef])).toBe(initialTip);
          expect(yield* git(mirror, ["rev-parse", branchRef])).toBe(initialTip);

          const result = yield* Effect.result(core.pushCurrentBranch(workspace, null));
          if (result._tag !== "Failure")
            throw new Error("Expected the multi-destination push to fail");
          expect(result.failure).toMatchObject({
            _tag: "GitCommandError",
            operation: pushOperation,
            command: `git push origin HEAD:${initialBranch}`,
            detail: expect.stringContaining(refusal),
          });
          expect((yield* fs.readFileString(log)).trimEnd().split("\n")).toEqual([
            `${pushOperation}\tgit@primary.invalid\tgit-receive-pack '/primary.git'`,
            `${pushOperation}\tgit@mirror.invalid\tgit-receive-pack '/mirror.git'`,
            `primary tip at mirror attempt\t${newTip}`,
          ]);
          expect(yield* git(primary, ["rev-parse", branchRef])).toBe(newTip);
          expect(yield* git(mirror, ["rev-parse", branchRef])).toBe(initialTip);
          expect(yield* git(source, ["rev-parse", branchRef])).toBe(initialTip);
        }).pipe(Effect.provideService(GitCore, core));
      }),
  );
});
