import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { describe, expect } from "vitest";

import {
  buildLargeText,
  commitWithDate,
  git,
  initRepoWithCommit,
  makeTmpDir,
  TestLayer,
  writeTextFile,
} from "./GitCore.test.helpers.ts";
import { GitCore } from "../Services/GitCore.ts";

it.layer(TestLayer)("git integration", (it) => {
  describe("GitCore", () => {
    it.effect("prepares commit context by auto-staging and creates commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), "new content\n");
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary.length).toBeGreaterThan(0);
        expect(context!.stagedPatch.length).toBeGreaterThan(0);

        const created = yield* core.commit(tmp, "Add README update", "- include updated content");
        expect(created.commitSha.length).toBeGreaterThan(0);
        expect(yield* git(tmp, ["log", "-1", "--pretty=%s"])).toBe("Add README update");
      }),
    );

    it.effect("prepareCommitContext stages only selected files when filePaths provided", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp, ["a.txt"]);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).not.toContain("b.txt");

        yield* core.commit(tmp, "Add only a.txt", "");

        const statusAfter = yield* git(tmp, ["status", "--porcelain"]);
        expect(statusAfter).toContain("b.txt");
        expect(statusAfter).not.toContain("a.txt");
      }),
    );

    it.effect("prepareCommitContext stages everything when filePaths is undefined", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).toContain("b.txt");
      }),
    );

    it.effect("prepareCommitContext truncates oversized staged patches instead of failing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());

        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("README.md");
        expect(context!.stagedPatch).toContain("[truncated]");
      }),
    );

    it.effect("readRangeContext truncates oversized diff patches instead of failing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/large-range-context" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/large-range-context" });
        yield* writeTextFile(path.join(tmp, "large.txt"), buildLargeText());
        yield* git(tmp, ["add", "large.txt"]);
        yield* git(tmp, ["commit", "-m", "Add large range context"]);

        const rangeContext = yield* core.readRangeContext(tmp, initialBranch);
        expect(rangeContext.commitSummary).toContain("Add large range context");
        expect(rangeContext.diffSummary).toContain("large.txt");
        expect(rangeContext.diffPatch).toContain("[truncated]");
      }),
    );

    it.effect("lists recent commits in reverse chronological order", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* commitWithDate(
          tmp,
          "second.txt",
          "two\n",
          "2026-06-07T10:00:00.000Z",
          "feat: second",
        );
        yield* commitWithDate(
          tmp,
          "third.txt",
          "three\n",
          "2026-06-08T10:00:00.000Z",
          "feat: third",
        );
        yield* git(tmp, ["tag", "v0.1.642-beta-1"]);
        yield* git(tmp, ["tag", "release-candidate"]);

        const result = yield* (yield* GitCore).listCommits({ cwd: tmp, limit: 2 });

        expect(result.commits).toHaveLength(2);
        expect(result.commits[0]?.subject).toBe("feat: third");
        expect(result.commits[1]?.subject).toBe("feat: second");
        expect(result.commits[0]?.tags).toEqual(["release-candidate", "v0.1.642-beta-1"]);
        expect(result.commits[1]?.tags).toEqual([]);
        expect(result.nextCursor).toBe(2);
      }),
    );

    it.effect("paginates older commits with cursor offsets", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* commitWithDate(
          tmp,
          "second.txt",
          "two\n",
          "2026-06-07T10:00:00.000Z",
          "feat: second",
        );
        yield* commitWithDate(
          tmp,
          "third.txt",
          "three\n",
          "2026-06-08T10:00:00.000Z",
          "feat: third",
        );

        const result = yield* (yield* GitCore).listCommits({ cwd: tmp, limit: 1, cursor: 1 });

        expect(result.commits).toHaveLength(1);
        expect(result.commits[0]?.subject).toBe("feat: second");
        expect(result.nextCursor).toBe(2);
      }),
    );

    it.effect("marks commits ahead of upstream as not pushed", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);
        yield* commitWithDate(
          source,
          "unpushed.txt",
          "local only\n",
          "2026-06-08T12:00:00.000Z",
          "feat: unpushed",
        );

        const result = yield* (yield* GitCore).listCommits({ cwd: source, limit: 5 });

        expect(result.commits[0]?.subject).toBe("feat: unpushed");
        expect(result.commits[0]?.isPushed).toBe(false);
        expect(result.commits.some((commit) => commit.isPushed)).toBe(true);
      }),
    );

    it.effect("includes co-authors in commit summaries and details", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        yield* writeTextFile(path.join(tmp, "paired.txt"), "paired work\n");
        yield* git(tmp, ["add", "paired.txt"]);
        yield* git(
          tmp,
          [
            "commit",
            "--cleanup=verbatim",
            "-m",
            "feat: paired change",
            "-m",
            "Implemented with another author.\n\nCo-authored-by: Cursor <cursoragent@cursor.com>",
          ],
          {
            ...process.env,
            GIT_AUTHOR_DATE: "2026-06-08T13:00:00.000Z",
            GIT_COMMITTER_DATE: "2026-06-08T13:00:00.000Z",
          },
        );

        const core = yield* GitCore;
        const history = yield* core.listCommits({ cwd: tmp, limit: 5 });
        const summary = history.commits[0];
        expect(summary?.subject).toBe("feat: paired change");
        expect(summary?.authors).toEqual([
          { name: "Test", email: "test@test.com" },
          { name: "Cursor", email: "cursoragent@cursor.com" },
        ]);

        const sha = yield* git(tmp, ["rev-parse", "HEAD"]);
        const details = yield* core.getCommitDetails({ cwd: tmp, commit: sha });
        expect(details.commit.authors).toEqual([
          { name: "Test", email: "test@test.com" },
          { name: "Cursor", email: "cursoragent@cursor.com" },
        ]);
      }),
    );

    it.effect("reads commit details with file stats and patch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* commitWithDate(
          tmp,
          "history.txt",
          "alpha\nbeta\n",
          "2026-06-08T11:00:00.000Z",
          "feat: commit details",
        );
        yield* git(tmp, ["tag", "v0.1.642-beta-1"]);
        yield* git(tmp, ["tag", "release-candidate"]);
        const sha = yield* git(tmp, ["rev-parse", "HEAD"]);

        const result = yield* (yield* GitCore).getCommitDetails({ cwd: tmp, commit: sha });

        expect(result.commit.subject).toBe("feat: commit details");
        expect(result.commit.authors).toEqual([{ name: "Test", email: "test@test.com" }]);
        expect(result.commit.tags).toEqual(["release-candidate", "v0.1.642-beta-1"]);
        expect(result.commit.files.some((file) => file.path === "history.txt")).toBe(true);
        expect(result.commit.diff).toContain("diff --git a/history.txt b/history.txt");
      }),
    );

    it.effect("reads working tree diff for tracked and untracked files", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        yield* writeTextFile(path.join(tmp, "README.md"), "# updated\n");
        yield* writeTextFile(path.join(tmp, "new-file.txt"), "brand new\n");

        const result = yield* (yield* GitCore).readWorkingTreeDiff({ cwd: tmp });

        expect(result.diff).toContain("diff --git a/README.md b/README.md");
        expect(result.diff).toContain("diff --git a/new-file.txt b/new-file.txt");
      }),
    );

    it.effect("reads file-scoped working tree diff for a new file", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "new-file.txt"), "brand new\n");

        const result = yield* (yield* GitCore).readWorkingTreeDiff({
          cwd: tmp,
          path: "new-file.txt",
        });

        expect(result.diff).toContain("diff --git a/new-file.txt b/new-file.txt");
        expect(result.diff).toContain("+brand new");
      }),
    );

    it.effect("reads file-scoped working tree diff for a deleted file", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeTextFile(path.join(tmp, "delete-me.txt"), "remove me\n");
        yield* git(tmp, ["add", "delete-me.txt"]);
        yield* git(tmp, ["commit", "-m", "add delete target"]);
        yield* fileSystem.remove(path.join(tmp, "delete-me.txt"));

        const result = yield* (yield* GitCore).readWorkingTreeDiff({
          cwd: tmp,
          path: "delete-me.txt",
        });

        expect(result.diff).toContain("diff --git a/delete-me.txt b/delete-me.txt");
        expect(result.diff).toContain("deleted file mode");
      }),
    );
  });
});
