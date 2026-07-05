import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { resolveExistingWatchPath } from "./DiscoveryRegistry";

describe("DiscoveryRegistry watch path resolution", () => {
  it.layer(NodeServices.layer)("falls back to an existing immediate parent directory", (it) => {
    it.effect("watches the provider directory when the leaf path is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-watch-parent-" });
        const providerDir = path.join(cwd, ".opencode");
        const rawPath = path.join(providerDir, "skills");

        yield* fs.makeDirectory(providerDir, { recursive: true });

        const watchPath = yield* resolveExistingWatchPath(fs, path, rawPath);

        assert.strictEqual(watchPath, providerDir);
      }),
    );
  });

  it.layer(NodeServices.layer)(
    "does not fall back to the repo root for missing project roots",
    (it) => {
      it.effect("returns null when only the grandparent exists", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-watch-root-" });
          const rawPath = path.join(cwd, ".claude/agents");

          const watchPath = yield* resolveExistingWatchPath(fs, path, rawPath);

          assert.isNull(watchPath);
        }),
      );
    },
  );
});
