import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { describe, expect } from "vitest";

import {
  git,
  initRepoWithCommit,
  makeTmpDir,
  TestLayer,
  writeTextFile,
} from "./GitCore.test.helpers.ts";
import { GitCore } from "../Services/GitCore.ts";

it.layer(TestLayer)("git integration", (it) => {
  describe("GitCore", () => {
    it.effect("supports branch lifecycle operations through the service API", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;

        yield* core.initRepo({ cwd: tmp });
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "initial commit"]);

        yield* core.createBranch({ cwd: tmp, branch: "feature/service-api" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/service-api" });
        const branches = yield* core.listBranches({ cwd: tmp });

        expect(branches.isRepo).toBe(true);
        expect(
          branches.branches.find((branch: { current: boolean; name: string }) => branch.current)
            ?.name,
        ).toBe("feature/service-api");
      }),
    );

    it.effect(
      "reuses an existing remote when the target URL only differs by a trailing slash after .git",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const core = yield* GitCore;

          yield* git(tmp, ["remote", "add", "origin", "git@github.com:youpele52/bigbud.git"]);

          const remoteName = yield* core.ensureRemote({
            cwd: tmp,
            preferredName: "origin",
            url: "git@github.com:youpele52/bigbud.git/",
          });

          expect(remoteName).toBe("origin");
          expect((yield* git(tmp, ["remote"])).split("\n").filter(Boolean)).toEqual(["origin"]);
        }),
    );

    it.effect("reports status details and dirty state", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        const clean = yield* core.status({ cwd: tmp });
        expect(clean.hasWorkingTreeChanges).toBe(false);
        expect(clean.branch).toBeTruthy();

        yield* writeTextFile(path.join(tmp, "README.md"), "updated\n");
        const dirty = yield* core.statusDetails(tmp);
        expect(dirty.hasWorkingTreeChanges).toBe(true);
      }),
    );

    it.effect("expands untracked directories into individual files in status details", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const core = yield* GitCore;

        yield* fileSystem.makeDirectory(path.join(tmp, "untracked"), { recursive: true });
        yield* writeTextFile(path.join(tmp, "untracked", "one.ts"), "one\n");
        yield* writeTextFile(path.join(tmp, "untracked", "two.ts"), "two\n");

        const details = yield* core.statusDetails(tmp);

        expect(details.workingTree.files).toHaveLength(2);
        expect(details.workingTree.files.map((file) => file.path)).toContain("untracked/one.ts");
        expect(details.workingTree.files.map((file) => file.path)).toContain("untracked/two.ts");
        expect(
          details.workingTree.files.find((file) => file.path === "untracked/one.ts"),
        ).toMatchObject({
          insertions: 1,
          deletions: 0,
        });
        expect(
          details.workingTree.files.find((file) => file.path === "untracked/two.ts"),
        ).toMatchObject({
          insertions: 1,
          deletions: 0,
        });
        expect(details.workingTree.insertions).toBe(2);
        expect(details.workingTree.deletions).toBe(0);
      }),
    );

    it.effect("reports inserted lines for a new untracked file in status details", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "new-file.ts"), "one\ntwo\nthree\n");

        const details = yield* core.statusDetails(tmp);
        expect(details.workingTree.files.find((file) => file.path === "new-file.ts")).toMatchObject(
          {
            insertions: 3,
            deletions: 0,
          },
        );
        expect(details.workingTree.insertions).toBe(3);
      }),
    );

    it.effect("reports deleted lines for a removed tracked file in status details", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "deleted-file.ts"), "one\ntwo\nthree\n");
        yield* git(tmp, ["add", "deleted-file.ts"]);
        yield* git(tmp, ["commit", "-m", "add deleted file fixture"]);
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.remove(path.join(tmp, "deleted-file.ts"));

        const details = yield* core.statusDetails(tmp);
        expect(
          details.workingTree.files.find((file) => file.path === "deleted-file.ts"),
        ).toMatchObject({
          insertions: 0,
          deletions: 3,
        });
        expect(details.workingTree.deletions).toBe(3);
      }),
    );

    it.effect("computes ahead count against base branch when no upstream is configured", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* writeTextFile(path.join(tmp, "feature.txt"), "ahead of base\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const details = yield* core.statusDetails(tmp);
        expect(details.branch).toBe("feature/no-upstream-ahead");
        expect(details.hasUpstream).toBe(false);
        expect(details.aheadCount).toBe(1);
        expect(details.behindCount).toBe(0);
      }),
    );
  });
});
