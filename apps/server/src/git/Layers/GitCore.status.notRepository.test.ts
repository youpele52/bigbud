import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";

import { GitCore } from "../Services/GitCore.ts";
import {
  initRepoWithCommit,
  makeIsolatedGitCoreWithRemote,
  makeTmpDir,
  TestLayer,
  writeTextFile,
} from "./GitCore.test.helpers.ts";

it.layer(TestLayer)("git status outside a repository", (it) => {
  describe("GitCore status", () => {
    it.effect("reports isRepo: false for a real folder without .git", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir("git-not-repo-");
        const core = yield* GitCore;

        const details = yield* core.statusDetails(cwd);
        const localDetails = yield* core.statusDetailsLocal(cwd);
        const status = yield* core.status({ cwd });

        expect(details.isRepo).toBe(false);
        expect(localDetails.isRepo).toBe(false);
        expect(status.isRepo).toBe(false);
        expect(status.workingTree.files).toEqual([]);
      }),
    );

    it.effect("reports isRepo: false through the remote-agent executor path", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir("git-not-repo-remote-");
        const local = yield* GitCore;
        const targets: Array<string | undefined> = [];
        const remote = yield* makeIsolatedGitCoreWithRemote({
          execute: local.execute,
          remoteExecute: (input) => {
            targets.push(input.executionTargetId);
            return local.execute({ ...input, executionTargetId: "local" });
          },
        });

        const status = yield* remote.status({ cwd, executionTargetId: "ssh:example" });

        expect(status.isRepo).toBe(false);
        expect(targets.length).toBeGreaterThan(0);
        expect(targets.every((target) => target === "ssh:example")).toBe(true);
      }),
    );

    it.effect("still fails for a repository with a corrupt index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir("git-corrupt-");
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(path.join(cwd, ".git", "index"), "not an index");
        const core = yield* GitCore;

        const exit = yield* Effect.exit(core.statusDetails(cwd));

        expect(Exit.isFailure(exit)).toBe(true);
        expect(String(exit)).toContain("GitCore.statusDetails.status");
      }),
    );

    it.effect("still fails when .git points at a missing gitdir", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir("git-broken-gitfile-");
        yield* writeTextFile(path.join(cwd, ".git"), "gitdir: /nonexistent/bigbud-gitdir\n");
        const core = yield* GitCore;

        const exit = yield* Effect.exit(core.statusDetailsLocal(cwd));

        // Still a command error, never isRepo:false; git's wording for a broken gitfile varies
        // by version ("not a git repository: <path>" or "gitfile does not ...").
        expect(Exit.isFailure(exit)).toBe(true);
        expect(String(exit)).toContain("GitCore.statusDetailsLocal.status");
      }),
    );
  });
});
