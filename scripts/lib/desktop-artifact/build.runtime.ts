import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import {
  BuildArch,
  BuildPlatform,
  BuildScriptError,
  RepoRoot,
  commandOutputOptions,
  runCommand,
} from "./shared.ts";

// Packages that are NOT inlined by tsdown and must be installed at runtime.
// Must be kept in sync with EXTERNAL_PACKAGES in apps/server/tsdown.config.ts.
// Bun-only externals (@effect/sql-sqlite-bun, @effect/platform-bun) are excluded
// because they are never loaded in the Electron/Node.js desktop runtime.
const SERVER_RUNTIME_EXTERNAL_PACKAGES = new Set([
  "node-pty",
  "@github/copilot-sdk",
  "@earendil-works/pi-coding-agent",
]);

const NATIVE_SERVER_EXTERNAL_PACKAGES = new Set(["node-pty"]);

/** Filter a dependency map to only include packages that are external at runtime. */
export function pickExternalDependencies(
  dependencies: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (SERVER_RUNTIME_EXTERNAL_PACKAGES.has(name)) {
      result[name] = version;
    }
  }
  return result;
}

/**
 * Like pickExternalDependencies but excludes native compiled addons.
 *
 * Native addons must only live in the staged server directory (loaded from
 * _modules at runtime). Installing them in the app-root node_modules triggers
 * electron-builder's implicit npmRebuild which hangs on Windows.
 */
export function pickNonNativeExternalDependencies(
  dependencies: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (SERVER_RUNTIME_EXTERNAL_PACKAGES.has(name) && !NATIVE_SERVER_EXTERNAL_PACKAGES.has(name)) {
      result[name] = version;
    }
  }
  return result;
}

function resolveOpencodeWindowsPackageName(arch: typeof BuildArch.Type): string {
  switch (arch) {
    case "x64":
      return "opencode-windows-x64";
    case "arm64":
      return "opencode-windows-arm64";
    default:
      return "opencode-windows-x64";
  }
}

export const stagePackagedOpencodeWindowsBinary = Effect.fn("stagePackagedOpencodeWindowsBinary")(
  function* (input: {
    readonly stageRoot: string;
    readonly stageServerDir: string;
    readonly arch: typeof BuildArch.Type;
    readonly verbose: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageName = resolveOpencodeWindowsPackageName(input.arch);
    const installDir = path.join(input.stageRoot, "opencode-binary-install");

    yield* fs.makeDirectory(installDir, { recursive: true });
    // npm enforces host os/cpu checks for these platform packages, so force the
    // install by exact package name when staging a Windows binary from any host.
    yield* runCommand(
      ChildProcess.make({
        cwd: installDir,
        ...commandOutputOptions(input.verbose),
        shell: true,
      })`npm install --no-save --ignore-scripts --force ${packageName}`,
    );

    const packageDir = path.join(installDir, "node_modules", packageName);
    const binaryPath = path.join(packageDir, "bin", "opencode.exe");
    if (!(yield* fs.exists(binaryPath))) {
      return yield* new BuildScriptError({
        message: `Expected packaged OpenCode binary at ${binaryPath}`,
      });
    }

    const targetDir = path.join(input.stageServerDir, "opencode", "bin");
    yield* fs.makeDirectory(targetDir, { recursive: true });
    yield* fs.copyFile(binaryPath, path.join(targetDir, "opencode.exe"));
  },
);

const WINDOWS_ELECTRON_BUILDER_VERSION = "26.15.3";

export const resolveElectronBuilderBinary = Effect.fn("resolveElectronBuilderBinary")(function* (
  platform: typeof BuildPlatform.Type,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;

  if (platform === "win") {
    return {
      binary: "bunx",
      fallback: true,
      packageSpecifier: `electron-builder@${WINDOWS_ELECTRON_BUILDER_VERSION}`,
    } as const;
  }

  const localBinary = yield* Effect.try({
    try: () => {
      const require = createRequire(path.join(repoRoot, "apps/desktop/package.json"));
      const packageJsonPath = require.resolve("electron-builder/package.json");
      const pkgDir = dirname(packageJsonPath);
      const cliPath = path.join(pkgDir, "cli.js");
      if (existsSync(cliPath)) {
        return cliPath;
      }
      const altCliPath = path.join(pkgDir, "out", "cli", "cli.js");
      if (existsSync(altCliPath)) {
        return altCliPath;
      }
      return null;
    },
    catch: () => null,
  });

  if (localBinary) {
    return { binary: localBinary, fallback: false, packageSpecifier: undefined } as const;
  }

  yield* Effect.logWarning(
    "[desktop-artifact] Could not resolve local electron-builder; falling back to bunx. Add 'electron-builder' to apps/desktop devDependencies for reproducible builds.",
  );
  return { binary: "bunx", fallback: true, packageSpecifier: "electron-builder" } as const;
});

export const pruneMacServerRuntimeArtifacts = Effect.fn("pruneMacServerRuntimeArtifacts")(
  function* (serverNodeModulesDir: string) {
    yield* Effect.tryPromise({
      try: async () => {
        const removableDirectoryNames = new Set(["linux", "win32", "windows"]);

        const visit = async (currentDir: string): Promise<void> => {
          const entries = await readdir(currentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const entryPath = join(currentDir, entry.name);
            if (removableDirectoryNames.has(entry.name.toLowerCase())) {
              await rm(entryPath, { recursive: true, force: true });
              continue;
            }

            await visit(entryPath);
          }
        };

        await visit(serverNodeModulesDir);
      },
      catch: (cause) =>
        new BuildScriptError({
          message: `Failed to prune non-mac native runtime artifacts from ${serverNodeModulesDir}.`,
          cause,
        }),
    });
  },
);
