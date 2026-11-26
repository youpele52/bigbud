import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, describe, expect } from "vitest";

import {
  GIT_COMMIT_FILE_DIFF_LARGE_LIMIT_BYTES,
  GIT_COMMIT_FILE_DIFF_LIMIT_BYTES,
} from "@bigbud/contracts";
import { GitCore } from "../Services/GitCore.ts";
import { TestLayer } from "./GitCore.test.helpers.ts";
import { parseCommitNumstatZ } from "./GitHistory.commit.ts";

const root = mkdtempSync(join(tmpdir(), "bb-history-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();
}

// A commit whose total patch is well over 1 MB: 30 files of ~60 KB, one ~400 KB file, a rename.
git("init", "-q", "-b", "main");
writeFileSync(join(root, "keep.txt"), "line\n".repeat(50));
git("add", ".");
git("commit", "-q", "-m", "base");
for (let index = 0; index < 30; index += 1) {
  writeFileSync(join(root, `file-${index}.txt`), `${index} ${"y".repeat(60)}\n`.repeat(1_000));
}
writeFileSync(join(root, "huge.txt"), `${"z".repeat(99)}\n`.repeat(4_000));
git("mv", "keep.txt", "kept.txt");
git("add", ".");
git("commit", "-q", "-m", "large commit");
const sha = git("rev-parse", "HEAD");

describe("parseCommitNumstatZ", () => {
  it("keeps rename sources and binary flags", () => {
    expect(parseCommitNumstatZ("1\t2\ta.txt\0-\t-\tbin.dat\0\n0\t0\t\0old.txt\0new.txt\0")).toEqual(
      [
        { path: "a.txt", insertions: 1, deletions: 2 },
        { path: "bin.dat", insertions: 0, deletions: 0, binary: true },
        { path: "new.txt", oldPath: "old.txt", insertions: 0, deletions: 0 },
      ],
    );
  });
});

it.layer(TestLayer)("commit history over 1 MB", (it) => {
  it.effect("lists every file without reading the whole patch", () =>
    Effect.gen(function* () {
      const details = yield* (yield* GitCore).getCommitDetails({ cwd: root, commit: sha });
      expect(details.commit.subject).toBe("large commit");
      expect(details.commit.files).toHaveLength(32);
      expect(details.commit.files).toContainEqual({
        path: "kept.txt",
        oldPath: "keep.txt",
        insertions: 0,
        deletions: 0,
      });
    }),
  );

  it.effect("loads one file's diff, including a rename pair", () =>
    Effect.gen(function* () {
      const core = yield* GitCore;
      const one = yield* core.getCommitFileDiff({ cwd: root, commit: sha, path: "file-3.txt" });
      expect(one).toMatchObject({ tooLarge: false, limitBytes: GIT_COMMIT_FILE_DIFF_LIMIT_BYTES });
      expect(one.diff).toContain("+++ b/file-3.txt");
      const renamed = yield* core.getCommitFileDiff({
        cwd: root,
        commit: sha,
        path: "kept.txt",
        oldPath: "keep.txt",
      });
      expect(renamed.diff).toContain("rename from keep.txt");
    }),
  );

  it.effect("reports an oversized file as too large, and loads it at the larger cap", () =>
    Effect.gen(function* () {
      const core = yield* GitCore;
      const big = yield* core.getCommitFileDiff({ cwd: root, commit: sha, path: "huge.txt" });
      expect(big).toEqual({
        path: "huge.txt",
        diff: null,
        tooLarge: true,
        limitBytes: GIT_COMMIT_FILE_DIFF_LIMIT_BYTES,
      });
      const loaded = yield* core.getCommitFileDiff({
        cwd: root,
        commit: sha,
        path: "huge.txt",
        limit: "large",
      });
      expect(loaded.tooLarge).toBe(false);
      expect(loaded.limitBytes).toBe(GIT_COMMIT_FILE_DIFF_LARGE_LIMIT_BYTES);
    }),
  );
});
