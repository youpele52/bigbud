import { existsSync } from "node:fs";
import { join } from "node:path";

import { findWorkspaceAgentTarget, type WorkspaceAgentTarget } from "./workspace-agent-target.ts";

/**
 * Architecture the `@bigbud/server` build stages its native helpers for. The desktop artifact
 * build sets it when it packages a different architecture than the host (macOS x64 built on an
 * Apple Silicon runner), so the server build compiles only the target binaries and never ships
 * host binaries inside the cross-built app. Unset means the host architecture.
 */
export const SERVER_NATIVE_TARGET_ARCH_ENV = "BIGBUD_SERVER_NATIVE_TARGET_ARCH";

/** `cargo build --release` arguments and output path for one native helper. */
export function nativeReleaseBuildPlan(input: {
  readonly repoRoot: string;
  readonly packageName: string;
  readonly binaryName: string;
  readonly target: WorkspaceAgentTarget;
  readonly native: boolean;
}): { readonly cargoArgs: string[]; readonly source: string } {
  const cargoArgs = ["build", "--locked", "--release", "--package", input.packageName];
  if (!input.native) cargoArgs.push("--target", input.target.rustTarget);
  const source = input.native
    ? join(input.repoRoot, "target", "release", input.binaryName)
    : join(input.repoRoot, "target", input.target.rustTarget, "release", input.binaryName);
  return { cargoArgs, source };
}

/** Resolves the server build's native target from the environment; only the architecture may differ. */
export function resolveServerNativeTarget(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): { readonly target: WorkspaceAgentTarget; readonly native: boolean } {
  const requested = environment[SERVER_NATIVE_TARGET_ARCH_ENV]?.trim();
  if (requested && requested !== "arm64" && requested !== "x64") {
    throw new Error(`${SERVER_NATIVE_TARGET_ARCH_ENV} must be arm64 or x64, got '${requested}'.`);
  }
  const arch = requested || hostArch;
  const target = findWorkspaceAgentTarget(hostPlatform, arch);
  if (!target) throw new Error(`Unsupported server native target: ${hostPlatform}/${arch}`);
  return { target, native: arch === hostArch };
}

/** Fails loudly when a cargo build exited 0 but did not leave the expected binary behind. */
export function requireNativeBuildOutput(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing after the cargo build: expected ${path}`);
  }
}
