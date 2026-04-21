import rootPackageJson from "../../../package.json" with { type: "json" };
import desktopPackageJson from "../../../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../../../apps/server/package.json" with { type: "json" };

import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import {
  BuildScriptError,
  BuildArch,
  PLATFORM_CONFIG,
  RepoRoot,
  commandOutputOptions,
  encodeJsonString,
  resolveGitCommitHash,
  resolvePythonForNodeGyp,
  runCommand,
  type ResolvedBuildOptions,
  type StagePackageJson,
} from "./shared.ts";
import {
  assertPlatformBuildResources,
  createBuildConfig,
  resolveDesktopRuntimeDependencies,
  validateBundledClientAssets,
} from "./resources.ts";
import { resolveCatalogDependencies } from "../resolve-catalog.ts";
import { isWindowsBuildPlatform, shellOptionForPlatform } from "./platform.ts";

// Packages that are NOT inlined by tsdown and must be installed at runtime.
// Must be kept in sync with EXTERNAL_PACKAGES in apps/server/tsdown.config.ts.
// Bun-only externals (@effect/sql-sqlite-bun, @effect/platform-bun) are excluded
// because they are never loaded in the Electron/Node.js desktop runtime.
const SERVER_RUNTIME_EXTERNAL_PACKAGES = new Set([
  "node-pty",
  "@github/copilot-sdk",
  "@mariozechner/pi-coding-agent",
]);

/** Filter a dependency map to only include packages that are external at runtime. */
function pickExternalDependencies(dependencies: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (SERVER_RUNTIME_EXTERNAL_PACKAGES.has(name)) {
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

const stagePackagedOpencodeWindowsBinary = Effect.fn("stagePackagedOpencodeWindowsBinary")(
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

export const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new BuildScriptError({
      message: "Could not resolve production dependencies from apps/server/package.json.",
    });
  }

  const resolvedServerDependencies = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(
        serverDependencies,
        rootPackageJson.workspaces.catalog,
        "apps/server",
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve production dependencies from apps/server/package.json.",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () =>
      resolveDesktopRuntimeDependencies(
        desktopPackageJson.dependencies,
        rootPackageJson.workspaces.catalog,
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve desktop runtime dependencies from apps/desktop/package.json.",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const commitHash = resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({ prefix: `bigbud-desktop-${options.platform}-stage-` });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const stageServerDir = path.join(stageAppDir, "apps/server");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        ...commandOutputOptions(options.verbose),
        shell: shellOptionForPlatform(options.platform),
      })`bun run build:desktop`,
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`,
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(stageServerDir, { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageServerDir, "dist"));
  yield* assertPlatformBuildResources(options.platform, stageResourcesDir, options.verbose);
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));

  if (isWindowsBuildPlatform(options.platform)) {
    yield* stagePackagedOpencodeWindowsBinary({
      stageRoot,
      stageServerDir,
      arch: options.arch,
      verbose: options.verbose,
    });
  }

  // The server bundle is self-contained (all JS dependencies inlined by tsdown).
  // Only packages that cannot be bundled (native addons, runtime require.resolve)
  // need to be installed in the staged server directory.
  const serverExternalDependencies = pickExternalDependencies(resolvedServerDependencies);

  const stagePackageJson: StagePackageJson = {
    name: "bigbud-desktop",
    version: appVersion,
    buildVersion: appVersion,
    bigbudCommitHash: commitHash,
    private: true,
    description: "bigbud desktop app",
    author: "Youpele",
    main: "apps/desktop/dist-electron/main.js",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      desktopPackageJson.productName ?? "bigbud",
      options.signed,
      options.mockUpdates,
      options.mockUpdateServerPort,
    ),
    dependencies: {
      ...serverExternalDependencies,
      ...resolvedDesktopRuntimeDependencies,
    },
    devDependencies: {
      electron: desktopPackageJson.dependencies.electron,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  const stageServerPackageJson = {
    name: serverPackageJson.name,
    version: appVersion,
    private: true,
    type: serverPackageJson.type,
    bin: serverPackageJson.bin,
    files: serverPackageJson.files,
    dependencies: serverExternalDependencies,
  };
  const stageServerPackageJsonString = yield* encodeJsonString(stageServerPackageJson);
  yield* fs.writeFileString(
    path.join(stageServerDir, "package.json"),
    `${stageServerPackageJsonString}\n`,
  );

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      ...commandOutputOptions(options.verbose),
      shell: shellOptionForPlatform(options.platform),
    })`bun install --production`,
  );
  // Use npm (not bun) for the server directory so node_modules follows the
  // standard flat layout that Node.js expects. Bun's symlink-based hoisting
  // does not survive electron-builder's file copy to extraResources.
  // Do NOT use --no-optional: @github/copilot declares platform-specific
  // CLI binaries (@github/copilot-darwin-arm64, etc.) as optionalDependencies.
  // Without them the Copilot SDK has no CLI to spawn and listModels() returns
  // incomplete model shapes that crash at runtime.
  yield* runCommand(
    ChildProcess.make({
      cwd: stageServerDir,
      ...commandOutputOptions(options.verbose),
      shell: shellOptionForPlatform(options.platform),
    })`npm install --production`,
  );

  // electron-builder silently strips node_modules from extraResources copies.
  // Rename to _modules so the directory survives into the packaged app.
  // The desktop main process sets NODE_PATH to _modules when spawning the
  // backend child process so Node.js can still resolve these external packages.
  const serverNodeModules = path.join(stageServerDir, "node_modules");
  const serverModulesRenamed = path.join(stageServerDir, "_modules");
  if (yield* fs.exists(serverNodeModules)) {
    yield* fs.rename(serverNodeModules, serverModulesRenamed);
  }

  const buildEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (isWindowsBuildPlatform(options.platform)) {
    const python = resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: buildEnv,
      ...commandOutputOptions(options.verbose),
      shell: shellOptionForPlatform(options.platform),
    })`bunx electron-builder ${platformConfig.cliFlag} --${options.arch} --publish never`,
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});
