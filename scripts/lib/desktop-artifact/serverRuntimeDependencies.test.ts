import { pathToFileURL } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  SERVER_RUNTIME_NPM_OVERRIDES,
  writeServerRuntimeShims,
} from "./serverRuntimeDependencies.ts";

describe("serverRuntimeDependencies", () => {
  it.layer(NodeServices.layer)("stages local shims for deprecated runtime packages", (it) => {
    it.effect("overrides node-domexception with a relative file: shim", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(SERVER_RUNTIME_NPM_OVERRIDES, {
          "node-domexception": "file:./.runtime-shims/node-domexception",
        });
      }),
    );

    it.effect("writes a node-domexception shim that default-exports the native DOMException", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageServerDir = yield* fs.makeTempDirectoryScoped({ prefix: "server-shims-" });

        yield* writeServerRuntimeShims(stageServerDir);

        const shimDir = path.join(
          stageServerDir,
          SERVER_RUNTIME_NPM_OVERRIDES["node-domexception"]!.slice("file:./".length),
        );
        const packageJson = JSON.parse(
          yield* fs.readFileString(path.join(shimDir, "package.json")),
        ) as { name: string; main: string };
        assert.strictEqual(packageJson.name, "node-domexception");

        // fetch-blob uses `import DOMException from "node-domexception"`.
        const shim = yield* Effect.promise(
          () =>
            import(pathToFileURL(path.join(shimDir, packageJson.main)).href) as Promise<{
              default: unknown;
            }>,
        );
        assert.strictEqual(shim.default, globalThis.DOMException);
      }),
    );
  });
});
