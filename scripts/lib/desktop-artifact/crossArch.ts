/**
 * Target-architecture rules for desktop builds that package a different architecture than the
 * host (macOS x64 built on an Apple Silicon runner). Native builds keep their previous behavior:
 * every flag below resolves to the host values.
 */
import { spawnSync } from "node:child_process";

import { Effect } from "effect";

import { SERVER_NATIVE_TARGET_ARCH_ENV } from "../native-release-build.ts";
import { BuildScriptError, type BuildArch, type BuildPlatform } from "./shared.ts";

const TARGET_OS = { mac: "darwin", linux: "linux", win: "win32" } as const;

interface TargetInput {
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
}

/** True when the target OS matches the host but a single target architecture differs from it. */
export function isCrossArchBuild(input: TargetInput): boolean {
  return (
    input.arch !== "universal" &&
    TARGET_OS[input.platform] === (input.hostPlatform ?? process.platform) &&
    input.arch !== (input.hostArch ?? process.arch)
  );
}

/**
 * `--os`/`--cpu` overrides so npm and Bun install the target's optional platform packages on a
 * cross build (both accept the same flags). Native and universal builds keep the host selection
 * exactly as before, including npm's host libc detection on Linux.
 */
export function optionalDependencyTargetFlags(input: TargetInput): string[] {
  if (!isCrossArchBuild(input)) return [];
  return [`--os=${TARGET_OS[input.platform]}`, `--cpu=${input.arch}`];
}

/**
 * Arguments for the staged desktop runtime `bun install`. Cross builds skip lifecycle scripts:
 * Bun trusts msgpackr-extract by default, and its install script compiles a host addon when the
 * host prebuild package is absent (an arm64 `build/Release/extract.node` in the x64 app).
 */
export function stagedDesktopBunInstallArgs(input: TargetInput): string[] {
  return [
    "install",
    "--production",
    ...optionalDependencyTargetFlags(input),
    ...(isCrossArchBuild(input) ? ["--ignore-scripts"] : []),
  ];
}

/**
 * Arguments for the staged server `npm install`. Cross builds skip lifecycle scripts: they only
 * probe or compile native addons for the host (koffi rebuilds from source when its host prebuild
 * is absent), which would put host binaries in the target app. The architecture audit and the
 * packaged smoke tests verify the target binaries instead.
 */
export function stagedServerNpmInstallArgs(input: TargetInput): string[] {
  return [
    "install",
    "--omit=dev",
    "--install-links",
    ...optionalDependencyTargetFlags(input),
    ...(isCrossArchBuild(input) ? ["--ignore-scripts"] : []),
  ];
}

/**
 * Environment for `bun run build:desktop`: names the target architecture whenever the server
 * build can produce it (same OS), so a cross build skips the host-architecture Rust helpers.
 */
export function serverBuildEnvironment(
  input: TargetInput,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  delete environment[SERVER_NATIVE_TARGET_ARCH_ENV];
  if (
    input.arch !== "universal" &&
    TARGET_OS[input.platform] === (input.hostPlatform ?? process.platform)
  ) {
    environment[SERVER_NATIVE_TARGET_ARCH_ENV] = input.arch;
  }
  return environment;
}

/** Packaging runs the x64 helpers (`--check`, handshakes); on Apple Silicon that needs Rosetta 2. */
export const assertCrossArchExecutionSupport = Effect.fn("assertCrossArchExecutionSupport")(
  function* (input: TargetInput) {
    if (!isCrossArchBuild(input) || input.platform !== "mac" || input.arch !== "x64") return;
    const probe = spawnSync("arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" });
    if (probe.status !== 0) {
      return yield* new BuildScriptError({
        message:
          "Cross-building macOS x64 requires Rosetta 2 to smoke-test the x64 helpers. Install it " +
          "with `softwareupdate --install-rosetta --agree-to-license` and retry.",
      });
    }
  },
);
