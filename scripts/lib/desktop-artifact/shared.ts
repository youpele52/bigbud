import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, Layer, Logger, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { BRAND_ASSET_PATHS } from "../brand-assets.ts";

export const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
export const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

export const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);
export const ProductionMacIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacIconPng),
);
export const ProductionLinuxIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionLinuxIconPng),
);
export const ProductionWindowsIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionWindowsIconIco),
);
export const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

export interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

export const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

export interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<string>;
}

const aliasedConfig = <A>(primary: Config.Config<A>, legacy: Config.Config<A>) =>
  Config.all({
    primary: primary.pipe(Config.option),
    legacy: legacy.pipe(Config.option),
  }).pipe(Config.map(({ primary, legacy }) => Option.firstSomeOf([primary, legacy])));

const aliasedOptional = <A>(primary: Config.Config<A>, legacy: Config.Config<A>) =>
  aliasedConfig(primary, legacy);

const aliasedWithDefault = <A>(
  primary: Config.Config<A>,
  legacy: Config.Config<A>,
  defaultValue: A,
) =>
  aliasedConfig(primary, legacy).pipe(
    Config.map((value) => Option.getOrElse(value, () => defaultValue)),
  );

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  if (process.arch === "arm64" && config.archChoices.includes("arm64")) {
    return "arm64";
  }
  if (process.arch === "x64" && config.archChoices.includes("x64")) {
    return "x64";
  }

  return config.archChoices[0] ?? "x64";
}

export class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function resolveGitCommitHash(repoRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
}

export function resolvePythonForNodeGyp(): string | undefined {
  const configured = process.env.npm_config_python ?? process.env.PYTHON;
  if (configured && existsSync(configured)) {
    return configured;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = join(localAppData, "Programs", "Python", version, "python.exe");
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  const probe = spawnSync("python", ["-c", "import sys;print(sys.executable)"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !existsSync(executable)) {
    return undefined;
  }

  return executable;
}

export interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: string | undefined;
}

export interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly bigbudCommitHash: string;
  readonly private: true;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

export const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.string("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.string("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: aliasedOptional(
    Config.schema(BuildPlatform, "BIGBUD_DESKTOP_PLATFORM"),
    Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM"),
  ),
  target: aliasedOptional(
    Config.string("BIGBUD_DESKTOP_TARGET"),
    Config.string("T3CODE_DESKTOP_TARGET"),
  ),
  arch: aliasedOptional(
    Config.schema(BuildArch, "BIGBUD_DESKTOP_ARCH"),
    Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH"),
  ),
  version: aliasedOptional(
    Config.string("BIGBUD_DESKTOP_VERSION"),
    Config.string("T3CODE_DESKTOP_VERSION"),
  ),
  outputDir: aliasedOptional(
    Config.string("BIGBUD_DESKTOP_OUTPUT_DIR"),
    Config.string("T3CODE_DESKTOP_OUTPUT_DIR"),
  ),
  skipBuild: aliasedWithDefault(
    Config.boolean("BIGBUD_DESKTOP_SKIP_BUILD"),
    Config.boolean("T3CODE_DESKTOP_SKIP_BUILD"),
    false,
  ),
  keepStage: aliasedWithDefault(
    Config.boolean("BIGBUD_DESKTOP_KEEP_STAGE"),
    Config.boolean("T3CODE_DESKTOP_KEEP_STAGE"),
    false,
  ),
  signed: aliasedWithDefault(
    Config.boolean("BIGBUD_DESKTOP_SIGNED"),
    Config.boolean("T3CODE_DESKTOP_SIGNED"),
    false,
  ),
  verbose: aliasedWithDefault(
    Config.boolean("BIGBUD_DESKTOP_VERBOSE"),
    Config.boolean("T3CODE_DESKTOP_VERBOSE"),
    false,
  ),
  mockUpdates: aliasedWithDefault(
    Config.boolean("BIGBUD_DESKTOP_MOCK_UPDATES"),
    Config.boolean("T3CODE_DESKTOP_MOCK_UPDATES"),
    false,
  ),
  mockUpdateServerPort: aliasedOptional(
    Config.string("BIGBUD_DESKTOP_MOCK_UPDATE_SERVER_PORT"),
    Config.string("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT"),
  ),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig.asEffect();

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, env.mockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild: resolveBooleanFlag(input.skipBuild, env.skipBuild),
    keepStage: resolveBooleanFlag(input.keepStage, env.keepStage),
    signed: resolveBooleanFlag(input.signed, env.signed),
    verbose: resolveBooleanFlag(input.verbose, env.verbose),
    mockUpdates: resolveBooleanFlag(input.mockUpdates, env.mockUpdates),
    mockUpdateServerPort: mergeOptions(
      input.mockUpdateServerPort,
      env.mockUpdateServerPort,
      undefined,
    ),
  } satisfies ResolvedBuildOptions;
});

export const commandOutputOptions = (verbose: boolean) =>
  ({
    stdout: verbose ? "inherit" : "ignore",
    stderr: "inherit",
  }) as const;

export const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

export const desktopArtifactCliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
);
