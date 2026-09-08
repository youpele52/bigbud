import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  RemoteWorkspaceRuntime,
  WorkspaceRuntime,
  type WorkspaceRuntimeBackendShape,
} from "../Services/WorkspaceRuntime.ts";
import {
  makeTargetAwareRuntime,
  makeWorkspaceRuntimeLayer,
  WorkspaceRuntimeLayerLive,
} from "./WorkspaceRuntime.ts";

const TestLayer = WorkspaceRuntimeLayerLive.pipe(Layer.provideMerge(NodeServices.layer));

const remoteBackend = {
  files: {
    readFilePreview: () =>
      Effect.succeed({
        relativePath: "README.md",
        contents: "remote layer",
        sizeBytes: 12,
        truncated: false,
      }),
    listDirectory: () => Effect.succeed({ entries: [] }),
  },
  search: {
    searchEntries: () => Effect.succeed({ entries: [], truncated: false }),
    searchFileContents: () => Effect.succeed({ matches: [], truncated: false }),
  },
} as unknown as WorkspaceRuntimeBackendShape;

const RemoteTestLayer = makeWorkspaceRuntimeLayer(
  Layer.succeed(RemoteWorkspaceRuntime, remoteBackend),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "bigbud-workspace-runtime-" });
});

it.layer(TestLayer)("WorkspaceRuntime local composition", (it) => {
  it.effect("delegates the initial read surfaces without changing their results", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkspaceRuntime;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;

      yield* fileSystem.makeDirectory(path.join(cwd, "src"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(cwd, "src/example.ts"),
        "export const value = 1;\n",
      );

      const preview = yield* runtime.files.readFilePreview({ cwd, relativePath: "src/example.ts" });
      const directory = yield* runtime.files.listDirectory({ cwd, relativePath: "src" });
      const entries = yield* runtime.search.searchEntries({ cwd, query: "example", limit: 10 });
      const contents = yield* runtime.search.searchFileContents({ cwd, query: "value", limit: 10 });

      expect(preview.contents).toBe("export const value = 1;\n");
      expect(directory.entries).toEqual([
        { path: "src/example.ts", kind: "file", parentPath: "src" },
      ]);
      expect(entries.entries.map((entry) => entry.path)).toEqual(["src/example.ts"]);
      expect(contents.matches.map((match) => match.path)).toEqual(["src/example.ts"]);
    }),
  );

  it.effect("selects the explicit remote backend only for remote targets", () =>
    Effect.gen(function* () {
      const local = {
        files: {
          readFilePreview: () =>
            Effect.succeed({
              relativePath: "README.md",
              contents: "local",
              sizeBytes: 5,
              truncated: false,
            }),
          listDirectory: () => Effect.succeed({ entries: [] }),
        },
        search: {
          searchEntries: () => Effect.succeed({ entries: [], truncated: false }),
          searchFileContents: () => Effect.succeed({ matches: [], truncated: false }),
        },
      } as unknown as WorkspaceRuntimeBackendShape;
      const remote = {
        files: {
          readFilePreview: () =>
            Effect.succeed({
              relativePath: "README.md",
              contents: "remote",
              sizeBytes: 6,
              truncated: false,
            }),
          listDirectory: () => Effect.succeed({ entries: [] }),
        },
        search: {
          searchEntries: () => Effect.succeed({ entries: [], truncated: false }),
          searchFileContents: () => Effect.succeed({ matches: [], truncated: false }),
        },
      } as unknown as WorkspaceRuntimeBackendShape;
      const runtime = makeTargetAwareRuntime({ local, remote });

      const localResult = yield* runtime.files.readFilePreview({
        cwd: "/local",
        relativePath: "README.md",
        executionTargetId: "local",
      });
      const remoteResult = yield* runtime.files.readFilePreview({
        cwd: "/remote",
        relativePath: "README.md",
        executionTargetId: "ssh:example",
      });

      expect(localResult.contents).toBe("local");
      expect(remoteResult.contents).toBe("remote");
    }),
  );
});

it.layer(RemoteTestLayer)("WorkspaceRuntime remote composition", (it) => {
  it.effect("selects the remote backend for SSH execution targets", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkspaceRuntime;
      const result = yield* runtime.files.readFilePreview({
        cwd: "/remote",
        relativePath: "README.md",
        executionTargetId: "ssh:example",
      });
      expect(result.contents).toBe("remote layer");
    }),
  );
});
