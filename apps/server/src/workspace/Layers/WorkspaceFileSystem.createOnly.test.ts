import * as NodeServices from "@effect/platform-node/NodeServices";
import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "../../startup/config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import {
  WORKSPACE_FILE_ALREADY_EXISTS,
  WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
  WorkspaceFileSystem,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const TestLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(GitCoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "bigbud-workspace-files-create-only-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "bigbud-workspace-create-only-",
  });
});

it.layer(TestLayer)("WorkspaceFileSystem create-only writes", (it) => {
  describe("writeFile createOnly", () => {
    it.effect("creates a missing file and its parent folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: ".config/opencode/plugin/bigbud-done.js",
          contents: "export {};\n",
          createOnly: true,
        });

        expect(result).toEqual({ relativePath: ".config/opencode/plugin/bigbud-done.js" });
        const absolutePath = join(cwd, ".config/opencode/plugin/bigbud-done.js");
        expect(yield* Effect.promise(() => readFile(absolutePath, "utf8"))).toBe("export {};\n");
        const folder = yield* Effect.promise(() => stat(join(cwd, ".config/opencode/plugin")));
        expect(folder.isDirectory()).toBe(true);
        // Owner keeps full access; the process umask decides the rest.
        expect(folder.mode & 0o700).toBe(0o700);
      }),
    );

    it.effect("refuses an existing file with an already-exists error and leaves it untouched", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const absolutePath = join(cwd, "settings.json");
        yield* Effect.promise(() => writeFile(absolutePath, '{ "mine": true }\n'));

        const failure = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "settings.json",
            contents: "{}\n",
            createOnly: true,
          })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "WorkspaceFileSystemError",
          operation: WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
          detail: WORKSPACE_FILE_ALREADY_EXISTS,
          writeDisposition: "terminal",
        });
        expect(yield* Effect.promise(() => readFile(absolutePath, "utf8"))).toBe(
          '{ "mine": true }\n',
        );
      }),
    );

    it.effect("refuses a symlink, even a dangling one, without writing through it", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* Effect.promise(() => symlink("target.txt", join(cwd, "link.txt")));

        const failure = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "link.txt", contents: "x", createOnly: true })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({ detail: WORKSPACE_FILE_ALREADY_EXISTS });
        const target = yield* Effect.promise(() => stat(join(cwd, "target.txt")).catch(() => null));
        expect(target).toBeNull();
      }),
    );

    it.effect("rejects createOnly combined with expectedSha256 before writing", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const failure = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "new.txt",
            contents: "x",
            createOnly: true,
            expectedSha256: "a".repeat(64),
          })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({ writeDisposition: "not-dispatched" });
        const created = yield* Effect.promise(() => stat(join(cwd, "new.txt")).catch(() => null));
        expect(created).toBeNull();
      }),
    );
  });
});
