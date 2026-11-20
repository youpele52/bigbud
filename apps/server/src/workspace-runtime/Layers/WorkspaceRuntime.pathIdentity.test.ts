import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect, describe } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { Schema } from "effect";
import { ProjectListDirectoryResult } from "@bigbud/contracts/workspace/project";
import { WorkspaceRuntime } from "../Services/WorkspaceRuntime.ts";
import { WorkspaceRuntimeLayerLive } from "./WorkspaceRuntime.ts";

const TestLayer = WorkspaceRuntimeLayerLive.pipe(Layer.provideMerge(NodeServices.layer));

describe.skipIf(process.platform === "win32")("POSIX filesystem names", () => {
  it.layer(TestLayer)("workspace path identity", (it) => {
    it.effect("lists, expands, previews and writes whitespace-distinct siblings", () =>
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-path-identity-" });
        const cwd = path.join(temp, "workspace ");
        yield* fs.makeDirectory(cwd);
        for (const folder of ["folder", "folder ", " leading", "tab\tname", "line\nbreak", " "]) {
          yield* fs.makeDirectory(path.join(cwd, folder));
          yield* fs.writeFileString(path.join(cwd, folder, "file "), folder);
        }
        const listing = yield* runtime.files.listDirectory({ cwd });
        expect(Schema.encodeSync(ProjectListDirectoryResult)(listing)).toEqual(listing);
        expect(listing.entries.map((entry) => entry.path)).toContain("folder ");
        const nested = yield* runtime.files.listDirectory({ cwd, relativePath: "folder " });
        expect(nested.entries).toEqual([
          { path: "folder /file ", parentPath: "folder ", kind: "file" },
        ]);
        const original = yield* runtime.files.readFilePreview({
          cwd,
          relativePath: "folder /file ",
        });
        expect(original.contents).toBe("folder ");
        yield* runtime.files.writeFile({
          cwd,
          relativePath: "folder /file ",
          contents: "updated",
          expectedSha256: original.sha256,
        });
        const untouched = yield* runtime.files.readFilePreview({
          cwd,
          relativePath: "folder/file ",
        });
        expect(untouched.contents).toBe("folder");
        expect(yield* fs.readFileString(path.join(cwd, "folder /file "))).toBe("updated");
        const range = yield* runtime.files.readFileRange({
          cwd,
          relativePath: "folder /file ",
          offset: 0,
          maxBytes: 10,
        });
        expect(new TextDecoder().decode(range.bytes)).toBe("updated");
        const contents = yield* runtime.search.searchFileContents({
          cwd,
          query: "updated",
          limit: 10,
        });
        expect(contents.matches.map((match) => match.path)).toContain("folder /file ");
        const entries = yield* runtime.search.searchEntries({ cwd, query: "file", limit: 20 });
        expect(entries.entries.map((entry) => entry.path)).toContain("folder /file ");
      }),
    );
  });
});
