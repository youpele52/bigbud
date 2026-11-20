import { win32 } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { WorkspacePathsLive, makeWorkspacePaths } from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "bigbud-project-paths-",
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

it.layer(TestLayer)("WorkspacePathsLive", (it) => {
  describe("normalizeWorkspaceRoot", () => {
    it.effect("resolves an existing directory", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(cwd);

        expect(resolved).toBe(cwd);
      }),
    );

    it.effect("rejects missing directories", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(path.join(cwd, "missing"))
          .pipe(Effect.flip);

        expect(error.message).toContain("Workspace root does not exist:");
      }),
    );

    it.effect("rejects file paths", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const filePath = path.join(cwd, "README.md");
        yield* writeTextFile(cwd, "README.md", "# hi\n");

        const error = yield* workspacePaths.normalizeWorkspaceRoot(filePath).pipe(Effect.flip);

        expect(error.message).toContain("Workspace root is not a directory:");
      }),
    );
  });

  describe("resolveRelativePathWithinRoot", () => {
    it.effect("resolves relative paths inside the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: cwd,
          relativePath: "plans/effect-rpc.md",
        });

        expect(resolved).toEqual({
          absolutePath: path.join(cwd, "plans/effect-rpc.md"),
          relativePath: "plans/effect-rpc.md",
        });
      }),
    );

    it.effect("preserves whitespace and rejects unsafe paths", () =>
      Effect.gen(function* () {
        const paths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        for (const relativePath of [" leading/file ", " ", "tab\tname", "line\nbreak"]) {
          if (process.platform === "win32" && /[ .]$/.test(relativePath)) {
            const error = yield* paths
              .resolveRelativePathWithinRoot({ workspaceRoot: cwd, relativePath })
              .pipe(Effect.flip);
            expect(error._tag).toBe("WorkspacePathOutsideRootError");
            continue;
          }
          const resolved = yield* paths.resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath,
          });
          expect(resolved.relativePath).toBe(relativePath);
        }
        for (const relativePath of ["../escape", "/absolute", "a\0b", "", "."]) {
          const result = yield* paths
            .resolveRelativePathWithinRoot({ workspaceRoot: cwd, relativePath })
            .pipe(Effect.flip);
          expect(result._tag).toBe("WorkspacePathOutsideRootError");
        }
      }),
    );

    it.effect("resolves remote POSIX paths independently of the host platform", () =>
      Effect.gen(function* () {
        const paths = yield* WorkspacePaths;
        const result = yield* paths.resolveRelativePathWithinRoot({
          workspaceRoot: "/srv/project ",
          relativePath: "folder /file ",
          executionTargetId: "ssh:dev",
        });
        expect(result).toEqual({
          absolutePath: "/srv/project /folder /file ",
          relativePath: "folder /file ",
        });
      }),
    );

    it.effect("rejects local Win32 aliases while preserving remote POSIX names", () =>
      Effect.gen(function* () {
        const hostPath = yield* Path.Path;
        const paths = yield* makeWorkspacePaths.pipe(
          Effect.provideService(Path.Path, { ...hostPath, ...win32 }),
        );
        const rejected = yield* paths
          .resolveRelativePathWithinRoot({
            workspaceRoot: "C:\\workspace",
            relativePath: "folder /file ",
          })
          .pipe(Effect.flip);
        expect(rejected._tag).toBe("WorkspacePathOutsideRootError");
        const remote = yield* paths.resolveRelativePathWithinRoot({
          workspaceRoot: "/srv/workspace ",
          relativePath: "folder /file ",
          executionTargetId: "ssh:dev",
        });
        expect(remote.relativePath).toBe("folder /file ");
        expect(remote.absolutePath).toBe("/srv/workspace /folder /file ");
      }),
    );

    it.effect("rejects paths that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });
});
