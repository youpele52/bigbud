import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { resolveDiscoveryWatchTarget } from "./DiscoveryRegistry.watch.ts";

describe("DiscoveryRegistry watch target resolution", () => {
  it.layer(NodeServices.layer)("existing descriptor roots", (it) => {
    it.effect("watches an existing root directly", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-watch-direct-" });
        const rawPath = path.join(cwd, ".opencode", "skills");
        yield* fs.makeDirectory(rawPath, { recursive: true });

        const target = yield* resolveDiscoveryWatchTarget(fs, path, rawPath);

        assert.deepStrictEqual(target, { path: rawPath, parent: path.dirname(rawPath) });
      }),
    );
  });

  it.layer(NodeServices.layer)("missing leaf with an existing parent", (it) => {
    it.effect("watches the parent only for the missing leaf appearing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-watch-parent-" });
        const providerDir = path.join(cwd, ".opencode");
        const rawPath = path.join(providerDir, "skills");
        yield* fs.makeDirectory(providerDir, { recursive: true });

        const target = yield* resolveDiscoveryWatchTarget(fs, path, rawPath);

        assert.deepStrictEqual(target, { path: rawPath, parent: providerDir });
      }),
    );
  });

  it.layer(NodeServices.layer)("does not fall back past the immediate parent", (it) => {
    it.effect("returns null when only the grandparent exists", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-watch-root-" });
        const rawPath = path.join(cwd, ".claude/agents");

        const target = yield* resolveDiscoveryWatchTarget(fs, path, rawPath);

        assert.isNull(target);
      }),
    );
  });
});
