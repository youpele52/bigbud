import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Path } from "effect";
import { describe, expect } from "vitest";

import type { WorkspaceTrash } from "../../workspace/Layers/WorkspaceTrash.ts";
import { makeGitHelpers, makeRawExecute, wrapExecuteWithMetrics } from "./GitCoreExecutor.ts";
import { makeGitStatusOps } from "./GitStatus.ts";
import {
  git,
  GitCoreDependenciesLayer,
  initRepoWithCommit,
  makeTmpDir,
  TestLayer,
  writeTextFile,
} from "./GitCore.test.helpers.ts";

function makeFakeTrash(): WorkspaceTrash & { trashed: string[] } {
  const trashed: string[] = [];
  return {
    available: true,
    trashed,
    moveToTrash: async (absolutePath) => {
      trashed.push(absolutePath);
      const { rm } = await import("node:fs/promises");
      await rm(absolutePath);
    },
  };
}

const makeOps = (lane: "initiating" | "target", trash?: WorkspaceTrash) =>
  Effect.gen(function* () {
    const execute = wrapExecuteWithMetrics(yield* makeRawExecute());
    return yield* makeGitStatusOps(
      makeGitHelpers(execute),
      yield* Path.Path,
      lane === "initiating" ? trash : undefined,
    );
  }).pipe(Effect.provide(GitCoreDependenciesLayer));

const listed = (cwd: string) =>
  makeOps("target").pipe(
    Effect.flatMap((ops) => ops.statusDetailsLocal(cwd)),
    Effect.map((details) => details.workingTree.files.map((file) => file.path)),
  );

const setupRepo = Effect.gen(function* () {
  const tmp = yield* makeTmpDir("git-discard-");
  yield* initRepoWithCommit(tmp);
  yield* writeTextFile(path.join(tmp, "a.txt"), "a\n");
  yield* writeTextFile(path.join(tmp, "b.txt"), "b\n");
  yield* writeTextFile(path.join(tmp, "c.txt"), "c\n");
  yield* git(tmp, ["add", "."]);
  yield* git(tmp, ["commit", "-m", "files"]);
  return tmp;
});

const read = (cwd: string, name: string) => readFileSync(path.join(cwd, name), "utf8");

it.layer(TestLayer)("GitStatus.discard", (it) => {
  describe("discardChanges with a selection", () => {
    it.effect("restores a modified file, a staged file, and a deleted file to HEAD", () =>
      Effect.gen(function* () {
        const tmp = yield* setupRepo;
        yield* writeTextFile(path.join(tmp, "a.txt"), "changed\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "staged\n");
        yield* git(tmp, ["add", "b.txt"]);
        yield* git(tmp, ["rm", "-q", "c.txt"]);
        const ops = yield* makeOps("initiating", makeFakeTrash());

        yield* ops.discardChanges(tmp, undefined, "op-1", { scope: "paths", paths: ["a.txt"] });
        expect(read(tmp, "a.txt")).toBe("a\n");
        expect(read(tmp, "b.txt")).toBe("staged\n");

        yield* ops.discardChanges(tmp, undefined, "op-2", { scope: "paths", paths: ["b.txt"] });
        yield* ops.discardChanges(tmp, undefined, "op-3", { scope: "paths", paths: ["c.txt"] });
        expect(read(tmp, "b.txt")).toBe("b\n");
        expect(read(tmp, "c.txt")).toBe("c\n");
        expect(yield* git(tmp, ["status", "--porcelain"])).toBe("");
      }),
    );

    it.effect("moves a local untracked file to the Trash and deletes remotely through git", () =>
      Effect.gen(function* () {
        const tmp = yield* setupRepo;
        yield* writeTextFile(path.join(tmp, "new.txt"), "new\n");
        yield* writeTextFile(path.join(tmp, "other.txt"), "other\n");
        const trash = makeFakeTrash();
        const local = yield* makeOps("initiating", trash);
        yield* local.discardChanges(tmp, undefined, "op", { scope: "paths", paths: ["new.txt"] });
        expect(trash.trashed).toEqual([
          path.join(yield* git(tmp, ["rev-parse", "--show-toplevel"]), "new.txt"),
        ]);
        expect(existsSync(path.join(tmp, "other.txt"))).toBe(true);

        const remote = yield* makeOps("target");
        yield* remote.discardChanges(tmp, undefined, "op", {
          scope: "paths",
          paths: ["other.txt"],
        });
        expect(existsSync(path.join(tmp, "other.txt"))).toBe(false);
      }),
    );

    it.effect("restores both paths of a staged rename", () =>
      Effect.gen(function* () {
        const tmp = yield* setupRepo;
        yield* git(tmp, ["mv", "a.txt", "renamed.txt"]);
        expect(yield* listed(tmp)).toContain("renamed.txt");
        const ops = yield* makeOps("initiating", makeFakeTrash());
        yield* ops.discardChanges(tmp, undefined, "op", { scope: "paths", paths: ["renamed.txt"] });
        expect(read(tmp, "a.txt")).toBe("a\n");
        expect(existsSync(path.join(tmp, "renamed.txt"))).toBe(false);
        expect(yield* git(tmp, ["status", "--porcelain"])).toBe("");
      }),
    );

    it.effect("treats glob characters literally and works from a subdirectory", () =>
      Effect.gen(function* () {
        const tmp = yield* setupRepo;
        yield* writeTextFile(path.join(tmp, "a.txt"), "changed\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "changed\n");
        yield* writeTextFile(path.join(tmp, "*.txt"), "star\n");
        yield* git(tmp, ["add", "*.txt"]);
        yield* git(tmp, ["commit", "-q", "-m", "star", "--", "*.txt"]);
        yield* writeTextFile(path.join(tmp, "*.txt"), "star changed\n");
        const { mkdirSync } = yield* Effect.promise(() => import("node:fs"));
        mkdirSync(path.join(tmp, "sub"));
        const ops = yield* makeOps("initiating", makeFakeTrash());
        yield* ops.discardChanges(path.join(tmp, "sub"), undefined, "op", {
          scope: "paths",
          paths: ["*.txt"],
        });
        expect(read(tmp, "*.txt")).toBe("star\n");
        expect(read(tmp, "a.txt")).toBe("changed\n");
        expect(read(tmp, "b.txt")).toBe("changed\n");
      }),
    );

    it.effect("refuses path escapes and unlisted paths without changing anything", () =>
      Effect.gen(function* () {
        const tmp = yield* setupRepo;
        yield* writeTextFile(path.join(tmp, "a.txt"), "changed\n");
        const ops = yield* makeOps("initiating", makeFakeTrash());
        for (const bad of ["../a.txt", "/etc/passwd", "sub/../a.txt", "b.txt"]) {
          const error = yield* Effect.flip(
            ops.discardChanges(tmp, undefined, "op", { scope: "paths", paths: [bad] }),
          );
          expect(error.detail).toMatch(/outside the repository|out of date/);
        }
        expect(read(tmp, "a.txt")).toBe("changed\n");
      }),
    );

    it.effect("discards all listed files and refuses when the status changed", () =>
      Effect.gen(function* () {
        const tmp = yield* setupRepo;
        yield* writeTextFile(path.join(tmp, "a.txt"), "changed\n");
        yield* writeTextFile(path.join(tmp, "new.txt"), "new\n");
        const ops = yield* makeOps("initiating", makeFakeTrash());
        const seen = yield* listed(tmp);
        expect(seen).toEqual(["a.txt", "new.txt"]);

        yield* writeTextFile(path.join(tmp, "b.txt"), "unseen\n");
        const error = yield* Effect.flip(
          ops.discardChanges(tmp, undefined, "op", { scope: "all", paths: seen }),
        );
        expect(error.detail).toContain("out of date");
        expect(read(tmp, "a.txt")).toBe("changed\n");
        expect(existsSync(path.join(tmp, "new.txt"))).toBe(true);

        const current = yield* listed(tmp);
        yield* ops.discardChanges(tmp, undefined, "op", { scope: "all", paths: current });
        expect(yield* git(tmp, ["status", "--porcelain"])).toBe("");
      }),
    );
  });
});
