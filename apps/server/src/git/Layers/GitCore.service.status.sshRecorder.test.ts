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
  writeTextFile,
} from "./GitCore.test.helpers.ts";

// The recorder is the SSH executable as far as Git is concerned. It accepts only
// these synthetic destinations and runs the real Git pack protocol on local bare
// repos. No network, SSH configuration, or evaluation of the remote command.
const sshRecorder = `#!/bin/sh
set -eu
if [ "\${1-}" = -o ] && [ "\${2-}" = SendEnv=GIT_PROTOCOL ]; then
  shift 2
fi
[ "$#" -eq 2 ] || exit 97
printf '%s%s\\t%s\\t%s\\n' "\${FIXTURE_GIT_WRAPPER:+$FIXTURE_GIT_WRAPPER:}" "$FIXTURE_GIT_OPERATION" "$1" "$2" >> "$FIXTURE_SSH_LOG"
case "$1:$2" in
  "git@read.invalid:git-upload-pack '/fixture.git'")
    exec git upload-pack "$FIXTURE_READ_REPO" ;;
  "git@write.invalid:git-receive-pack '/fixture.git'")
    exec git receive-pack "$FIXTURE_WRITE_REPO" ;;
  "git@mirror.invalid:git-receive-pack '/mirror.git'")
    exec git receive-pack "$FIXTURE_MIRROR_REPO" ;;
  *) exit 98 ;;
esac
`;

const readTransport = "git@read.invalid\tgit-upload-pack '/fixture.git'";
const writeTransport = "git@write.invalid\tgit-receive-pack '/fixture.git'";
const mirrorTransport = "git@mirror.invalid\tgit-receive-pack '/mirror.git'";
const statusRefresh = `GitCore.fetchRemoteForStatus\t${readTransport}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it.layer(TestLayer)("GitCore local Git SSH baseline", (it) => {
  it.effect.skipIf(process.platform === "win32")(
    "distinguishes local-only status, upstream refresh, fetch, pull, and rewritten push transport",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const realCore = yield* GitCore;
        const fixtureRoot = yield* makeTmpDir("git-ssh-recorder-");
        const source = path.join(fixtureRoot, "source");
        const workspace = path.join(fixtureRoot, "workspace");
        const readRepo = path.join(fixtureRoot, "reader.git");
        const writeRepo = path.join(fixtureRoot, "writer.git");
        const mirrorRepo = path.join(fixtureRoot, "mirror.git");
        const recorder = path.join(fixtureRoot, "ssh-recorder");
        const repositoryWrapper = path.join(fixtureRoot, "repo-wrapper");
        const environmentWrapper = path.join(fixtureRoot, "env-wrapper");
        const log = path.join(fixtureRoot, "ssh.log");
        yield* fs.makeDirectory(source);
        yield* fs.makeDirectory(workspace);
        yield* fs.writeFileString(recorder, sshRecorder, { mode: 0o700 });
        for (const entry of [repositoryWrapper, environmentWrapper]) {
          yield* fs.writeFileString(
            entry,
            '#!/bin/sh\nFIXTURE_GIT_WRAPPER=${0##*/} exec "${0%/*}/ssh-recorder" "$@"\n',
            { mode: 0o700 },
          );
        }
        yield* fs.writeFileString(log, "");

        const clearedGitEnv = Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.startsWith("GIT_"))
            .map((key) => [key, undefined]),
        );
        const environment = {
          ...clearedGitEnv,
          HOME: fixtureRoot,
          XDG_CONFIG_HOME: fixtureRoot,
          GIT_CONFIG_GLOBAL: path.join(fixtureRoot, "empty.gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_SSH: recorder,
          GIT_SSH_VARIANT: "ssh",
          FIXTURE_SSH_LOG: log,
          FIXTURE_READ_REPO: readRepo,
          FIXTURE_WRITE_REPO: writeRepo,
          FIXTURE_MIRROR_REPO: mirrorRepo,
        };
        const makeCore = (transportEnv?: NodeJS.ProcessEnv) =>
          makeIsolatedGitCore((input) =>
            realCore.execute({
              ...input,
              env: {
                ...input.env,
                ...environment,
                ...transportEnv,
                FIXTURE_GIT_WRAPPER: undefined,
                FIXTURE_GIT_OPERATION: input.operation,
              },
            }),
          );
        const core = yield* makeCore();
        const readCalls = fs
          .readFileString(log)
          .pipe(Effect.map((text) => text.trimEnd().split("\n").filter(Boolean)));
        const clearCalls = fs.writeFileString(log, "");

        yield* Effect.gen(function* () {
          const { initialBranch } = yield* initRepoWithCommit(source);
          yield* git(source, ["clone", "--bare", source, readRepo]);
          yield* git(source, ["clone", "--bare", source, writeRepo]);
          yield* git(source, ["clone", "--bare", source, mirrorRepo]);
          yield* git(workspace, ["clone", readRepo, "."]);
          yield* git(workspace, ["config", "user.name", "Test"]);
          yield* git(workspace, ["config", "user.email", "test@test.com"]);
          yield* git(workspace, ["config", "remote.origin.url", "read:fixture.git"]);
          yield* git(workspace, ["config", "--add", "remote.origin.pushurl", "write:fixture.git"]);
          yield* git(workspace, ["config", "--add", "remote.origin.pushurl", "mirror:mirror.git"]);
          yield* git(workspace, ["config", "url.ssh://git@read.invalid/.insteadOf", "read:"]);
          yield* git(workspace, ["config", "url.ssh://git@write.invalid/.insteadOf", "write:"]);
          yield* git(workspace, ["config", "url.ssh://git@mirror.invalid/.insteadOf", "mirror:"]);
          yield* writeTextFile(path.join(source, "remote.txt"), "new upstream content\n");
          yield* git(source, ["add", "remote.txt"]);
          yield* git(source, ["commit", "-m", "upstream update"]);
          yield* git(source, ["push", readRepo, initialBranch]);

          expect((yield* core.statusDetailsLocal(workspace)).behindCount).toBe(0);
          expect(yield* readCalls).toEqual([]);
          expect((yield* core.statusDetails(workspace)).behindCount).toBe(1);
          expect(yield* readCalls).toEqual([statusRefresh]);

          yield* clearCalls;
          yield* core.fetch(workspace);
          expect(yield* readCalls).toEqual([`GitCore.fetch\t${readTransport}`]);

          // Observational refresh can run again if its cache expires under load.
          const explicitCalls = readCalls.pipe(
            Effect.map((calls) => calls.filter((call) => call !== statusRefresh)),
          );
          yield* clearCalls;
          expect((yield* core.pullCurrentBranch(workspace)).status).toBe("pulled");
          expect(yield* explicitCalls).toEqual([
            `GitCore.pullCurrentBranch.pull\t${readTransport}`,
          ]);
          expect(yield* git(workspace, ["rev-parse", "HEAD"])).toBe(
            yield* git(source, ["rev-parse", "HEAD"]),
          );

          yield* writeTextFile(path.join(workspace, "local.txt"), "new local content\n");
          yield* git(workspace, ["add", "local.txt"]);
          yield* git(workspace, ["commit", "-m", "local update"]);
          yield* clearCalls;
          expect((yield* core.pushCurrentBranch(workspace, null)).status).toBe("pushed");
          expect(yield* explicitCalls).toEqual([
            `GitCore.pushCurrentBranch.pushUpstream\t${writeTransport}`,
            `GitCore.pushCurrentBranch.pushUpstream\t${mirrorTransport}`,
          ]);
          const head = yield* git(workspace, ["rev-parse", "HEAD"]);
          expect(yield* git(writeRepo, ["rev-parse", initialBranch])).toBe(head);
          expect(yield* git(mirrorRepo, ["rev-parse", initialBranch])).toBe(head);

          // In the legacy local-workspace lane a repo override beats GIT_SSH,
          // and an explicit GIT_SSH_COMMAND beats the repo override.
          yield* git(workspace, ["config", "core.sshCommand", quote(repositoryWrapper)]);
          yield* clearCalls;
          yield* core.fetch(workspace);
          expect(yield* readCalls).toEqual([`repo-wrapper:GitCore.fetch\t${readTransport}`]);

          const envCore = yield* makeCore({ GIT_SSH_COMMAND: quote(environmentWrapper) });
          yield* clearCalls;
          yield* envCore.fetch(workspace);
          expect(yield* readCalls).toEqual([`env-wrapper:GitCore.fetch\t${readTransport}`]);
        }).pipe(Effect.provideService(GitCore, core));
      }),
  );
});
