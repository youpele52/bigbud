import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../startup/config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "bigbud-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("readFilePreview", () => {
    it.effect("reads text files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/example.ts", "export const value = 1;\n");

        const result = yield* workspaceFileSystem.readFilePreview({
          cwd,
          relativePath: "src/example.ts",
        });

        expect(result).toEqual({
          relativePath: "src/example.ts",
          contents: "export const value = 1;\n",
          sizeBytes: 24,
          truncated: false,
        });
      }),
    );

    it.effect("reads text files at the 5 MiB size limit", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const contents = "a".repeat(5 * 1024 * 1024);
        yield* writeTextFile(cwd, "src/large.ts", contents);

        const result = yield* workspaceFileSystem.readFilePreview({
          cwd,
          relativePath: "src/large.ts",
        });

        expect(result.contents).toBe(contents);
        expect(result.sizeBytes).toBe(contents.length);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("rejects previews larger than 5 MiB", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "large.txt", "a".repeat(5 * 1024 * 1024 + 1));

        const error = yield* workspaceFileSystem
          .readFilePreview({ cwd, relativePath: "large.txt" })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "WorkspaceFileSystemError",
          detail: "File is too large to preview (maximum 5 MiB).",
        });
      }),
    );

    it.effect("rejects NUL bytes and invalid UTF-8 previews", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        yield* fileSystem.writeFile(path.join(cwd, "nul.txt"), new Uint8Array([0x61, 0, 0x62]));
        const nulError = yield* workspaceFileSystem
          .readFilePreview({ cwd, relativePath: "nul.txt" })
          .pipe(Effect.flip);

        expect(nulError).toMatchObject({
          _tag: "WorkspaceFileSystemError",
          detail: "File is not valid UTF-8 text and cannot be previewed.",
        });

        yield* fileSystem.writeFile(path.join(cwd, "invalid.txt"), new Uint8Array([0xc3, 0x28]));
        const invalidError = yield* workspaceFileSystem
          .readFilePreview({ cwd, relativePath: "invalid.txt" })
          .pipe(Effect.flip);

        expect(invalidError).toMatchObject({
          _tag: "WorkspaceFileSystemError",
          detail: "File is not valid UTF-8 text and cannot be previewed.",
        });
      }),
    );

    it.effect("rejects previews outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFilePreview({
            cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });

  describe("searchFileContents", () => {
    it.effect("finds matching text lines in the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/example.ts",
          "export const needle = 1;\nexport const other = 2;\n",
        );

        const result = yield* workspaceFileSystem.searchFileContents({
          cwd,
          query: "needle",
          limit: 10,
        });

        expect(result).toEqual({
          matches: [
            {
              path: "src/example.ts",
              line: 1,
              column: 14,
              lineText: "export const needle = 1;",
            },
          ],
          truncated: false,
        });
      }),
    );

    it.effect("limits matches and marks truncated results", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/one.ts", "needle one\n");
        yield* writeTextFile(cwd, "src/two.ts", "needle two\n");

        const result = yield* workspaceFileSystem.searchFileContents({
          cwd,
          query: "needle",
          limit: 1,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("falls back to filesystem search when rg is unavailable", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const previousPath = process.env.PATH;
        process.env.PATH = "";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            process.env.PATH = previousPath;
          }),
        );
        yield* writeTextFile(cwd, "src/example.ts", "export const fallbackNeedle = true;\n");

        const result = yield* workspaceFileSystem.searchFileContents({
          cwd,
          query: "fallbackNeedle",
          limit: 10,
        });

        expect(result).toEqual({
          matches: [
            {
              path: "src/example.ts",
              line: 1,
              column: 14,
              lineText: "export const fallbackNeedle = true;",
            },
          ],
          truncated: false,
        });
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );
  });
});
