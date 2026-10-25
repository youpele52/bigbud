import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { BuildPlatform, commandOutputOptions, runCommand } from "./shared.ts";
import { shellOptionForPlatform } from "./platform.ts";

// Local shims for deprecated transitive dependencies of the staged server
// runtime. They live in the staged server directory only while npm installs and
// are copied into node_modules (`--install-links`), never symlinked.
const SHIMS_DIR_NAME = ".runtime-shims";

// node-domexception is pulled in via @earendil-works/pi-coding-agent → pi-ai →
// @google/genai → google-auth-library → gaxios → node-fetch@3 → fetch-blob.
// Every published version is deprecated ("Use your platform's native
// DOMException instead"), and fetch-blob default-imports it, so the shim must
// export the native constructor as `module.exports`.
// npm cannot apply overrides inside a dependency's npm-shrinkwrap.json, so this
// only takes effect with pi-coding-agent >= 1.0.4 (earlier releases ship one).
const RUNTIME_SHIMS = {
  "node-domexception": {
    packageJson: {
      name: "node-domexception",
      version: "1.0.0",
      type: "commonjs",
      main: "index.js",
      license: "MIT",
    },
    indexJs: "module.exports = globalThis.DOMException;\n",
  },
} as const;

/** npm `overrides` for the staged server package.json, pointing at the local shims. */
export const SERVER_RUNTIME_NPM_OVERRIDES: Record<string, string> = Object.fromEntries(
  Object.keys(RUNTIME_SHIMS).map((name) => [name, `file:./${SHIMS_DIR_NAME}/${name}`]),
);

export const writeServerRuntimeShims = Effect.fn("writeServerRuntimeShims")(function* (
  stageServerDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const [name, shim] of Object.entries(RUNTIME_SHIMS)) {
    const shimDir = path.join(stageServerDir, SHIMS_DIR_NAME, name);
    yield* fs.makeDirectory(shimDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(shimDir, "package.json"),
      `${JSON.stringify(shim.packageJson, null, 2)}\n`,
    );
    yield* fs.writeFileString(path.join(shimDir, "index.js"), shim.indexJs);
  }
});

export const installStagedServerDependencies = Effect.fn("installStagedServerDependencies")(
  function* (input: {
    readonly stageServerDir: string;
    readonly platform: typeof BuildPlatform.Type;
    readonly verbose: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* writeServerRuntimeShims(input.stageServerDir);
    // Use npm (not bun) for the server directory so node_modules follows the
    // standard flat layout that Node.js expects. Bun's symlink-based hoisting
    // does not survive electron-builder's file copy to extraResources.
    // Do NOT use --no-optional: @github/copilot declares platform-specific
    // CLI binaries (@github/copilot-darwin-arm64, etc.) as optionalDependencies.
    // Without them the Copilot SDK has no CLI to spawn and listModels() returns
    // incomplete model shapes that crash at runtime.
    // --install-links copies the file: shims into node_modules instead of
    // symlinking them, for the same electron-builder reason.
    yield* runCommand(
      ChildProcess.make({
        cwd: input.stageServerDir,
        ...commandOutputOptions(input.verbose),
        shell: shellOptionForPlatform(input.platform),
      })`npm install --omit=dev --install-links`,
    );
    yield* fs.remove(path.join(input.stageServerDir, SHIMS_DIR_NAME), { recursive: true });
  },
);
