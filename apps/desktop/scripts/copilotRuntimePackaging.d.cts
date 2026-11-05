export type CopilotPackagingMode = "bridge" | "slim";
export function resolveCopilotPackagingMode(environment?: NodeJS.ProcessEnv): CopilotPackagingMode;
export function copilotPackagingTargets(
  platform: "mac" | "win" | "linux",
  arch: "x64" | "arm64" | "universal",
): string[];
export function pruneCopilotRuntimePackages(
  modulesDirectory: string,
  mode: CopilotPackagingMode,
  targets?: readonly string[],
): string[];
export function writeCopilotPackagingManifest(
  serverDirectory: string,
  mode: CopilotPackagingMode,
  targets: readonly string[],
): void;
export function assertCopilotRuntimePackaging(serverDirectory: string): {
  format: string;
  mode: CopilotPackagingMode;
  targets: string[];
};
