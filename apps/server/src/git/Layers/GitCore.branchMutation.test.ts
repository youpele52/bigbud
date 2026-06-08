import { existsSync } from "node:fs";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  git,
  initRepoWithCommit,
  makeIsolatedGitCore,
  makeTmpDir,
  TestLayer,
  writeTextFile,
} from "./GitCore.test.helpers.ts";
import { GitCore } from "../Services/GitCore.ts";

it.layer(TestLayer)("git integration", (it) => {
  describe("createGitBranch", () => {
    it.effect("creates a new branch visible in listGitBranches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "new-feature" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.some((b) => b.name === "new-feature")).toBe(true);
      }),
    );

    it.effect("throws when branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "dupe" });
        const result = yield* Effect.result(
          (yield* GitCore).createBranch({ cwd: tmp, branch: "dupe" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  describe("renameGitBranch", () => {
    it.effect("renames the current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/old-name" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");

        const branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "feature/old-name")).toBe(false);
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("feature/new-name");
      }),
    );

    it.effect("returns success without git invocation when old/new names match", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const current = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!;

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: current.name,
          newBranch: current.name,
        });

        expect(renamed.branch).toBe(current.name);
      }),
    );

    it.effect("appends numeric suffix when target branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/feat/session" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/tmp-working" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "t3code/tmp-working" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "t3code/tmp-working",
          newBranch: "t3code/feat/session",
        });

        expect(renamed.branch).toBe("t3code/feat/session-1");
        const branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "t3code/feat/session")).toBe(
          true,
        );
        expect(branches.branches.some((branch) => branch.name === "t3code/feat/session-1")).toBe(
          true,
        );
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("t3code/feat/session-1");
      }),
    );

    it.effect("increments suffix until it finds an available branch name", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/feat/session" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/feat/session-1" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/tmp-working" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "t3code/tmp-working" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "t3code/tmp-working",
          newBranch: "t3code/feat/session",
        });

        expect(renamed.branch).toBe("t3code/feat/session-2");
      }),
    );

    it.effect("uses '--' separator for branch rename arguments", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/old-name" });

        const realGitCore = yield* GitCore;
        let renameArgs: ReadonlyArray<string> | null = null;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "branch" && input.args[1] === "-m") {
            renameArgs = [...input.args];
          }

          return realGitCore.execute(input);
        });

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");
        expect(renameArgs).toEqual(["branch", "-m", "--", "feature/old-name", "feature/new-name"]);
      }),
    );
  });

  describe("createGitWorktree", () => {
    it.effect("creates a worktree with a new branch from the base branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "worktree-out");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-branch",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("wt-branch");
        expect(existsSync(wtPath)).toBe(true);
        expect(existsSync(path.join(wtPath, "README.md"))).toBe(true);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("worktree has the new branch checked out", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-check-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-check",
          path: wtPath,
        });

        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("wt-check");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("creates a worktree for an existing branch when newBranch is omitted", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/existing-worktree" });

        const wtPath = path.join(tmp, "wt-existing");
        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: "feature/existing-worktree",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("feature/existing-worktree");
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("feature/existing-worktree");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("throws when new branch name already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "existing" });

        const wtPath = path.join(tmp, "wt-conflict");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* Effect.result(
          (yield* GitCore).createWorktree({
            cwd: tmp,
            branch: currentBranch,
            newBranch: "existing",
            path: wtPath,
          }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("listGitBranches from worktree cwd reports worktree branch as current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-list-dir");
        const mainBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: mainBranch,
          newBranch: "wt-list",
          path: wtPath,
        });

        const wtBranches = yield* (yield* GitCore).listBranches({ cwd: wtPath });
        expect(wtBranches.isRepo).toBe(true);
        const wtCurrent = wtBranches.branches.find((b) => b.current);
        expect(wtCurrent!.name).toBe("wt-list");

        const mainBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(mainBranch);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("removeGitWorktree cleans up the worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-remove-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-remove",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );

    it.effect("removeGitWorktree force removes a dirty worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-dirty-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-dirty",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* writeTextFile(path.join(wtPath, "README.md"), "dirty change\n");

        const failedRemove = yield* Effect.result(
          (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath }),
        );
        expect(failedRemove._tag).toBe("Failure");
        expect(existsSync(wtPath)).toBe(true);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath, force: true });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );
  });

  describe("full flow: local branch checkout", () => {
    it.effect("init → commit → create branch → checkout → verify current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-login" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature-login" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature-login");
      }),
    );
  });

  describe("full flow: worktree creation", () => {
    it.effect("creates worktree with new branch from current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const wtPath = path.join(tmp, "my-worktree");
        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "feature-wt",
          path: wtPath,
        });

        expect(existsSync(result.worktree.path)).toBe(true);

        const mainBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(currentBranch);

        const wtBranch = yield* git(wtPath, ["branch", "--show-current"]);
        expect(wtBranch).toBe("feature-wt");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );
  });
});
