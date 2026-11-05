import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import Path from "node:path";

export interface ManagedCopilotRuntime {
  readonly path: string;
  readonly version: string;
  readonly target: string;
  readonly directory: string;
}

/** Runtime data is separate from signed app resources and from chats/auth/settings. */
export function copilotRuntimeRoot(
  input: {
    readonly platform?: NodeJS.Platform;
    readonly home?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  const path = platform === "win32" ? Path.win32 : Path.posix;
  const configuredData = platform === "win32" ? env.APPDATA : env.XDG_DATA_HOME;
  const data =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : configuredData && path.isAbsolute(configuredData)
        ? configuredData
        : platform === "win32"
          ? path.join(home, "AppData", "Roaming")
          : path.join(home, ".local", "share");
  return path.join(data, "bigbud", "runtimes", "copilot");
}

const VERSION_TARGET = /^(\d+\.\d+\.\d+)\/(darwin|win32|linux|linuxmusl)-(arm64|x64)$/;

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
  );
}

/** Reads only atomically published, marked installations; never follows managed symlinks. */
export function readManagedCopilotRuntime(
  root = copilotRuntimeRoot(),
): ManagedCopilotRuntime | undefined {
  try {
    if (!lstatSync(root).isDirectory()) return undefined;
    const pointer = Path.join(root, "current");
    if (!lstatSync(pointer).isFile() || lstatSync(pointer).size > 128) return undefined;
    return readManagedCopilotVersion(root, readFileSync(pointer, "utf8").trim());
  } catch (error) {
    if (isUnavailable(error)) return undefined;
    throw error;
  }
}

/** Resolves an owned version without changing the current pointer or any running session. */
export function readManagedCopilotVersion(
  root: string,
  relative: string,
): ManagedCopilotRuntime | undefined {
  try {
    if (!lstatSync(root).isDirectory()) return undefined;
    const match = VERSION_TARGET.exec(relative);
    if (!match) return undefined;
    const [, version, platform, arch] = match;
    if (!version || !platform || !arch) return undefined;
    const directory = Path.join(root, relative);
    for (const part of [Path.join(root, version), directory]) {
      if (!lstatSync(part).isDirectory()) return undefined;
    }
    const marker = Path.join(directory, ".bigbud-owned");
    if (!lstatSync(marker).isFile() || lstatSync(marker).size > 128) return undefined;
    if (readFileSync(marker, "utf8") !== `bigbud.copilot.v1\n${relative}\n`) return undefined;
    const path = Path.join(directory, "package", platform === "win32" ? "copilot.exe" : "copilot");
    if (!lstatSync(Path.join(directory, "package")).isDirectory()) return undefined;
    const binary = lstatSync(path);
    if (
      !binary.isFile() ||
      binary.size === 0 ||
      (platform !== "win32" && process.platform !== "win32" && !(binary.mode & 0o111))
    ) {
      return undefined;
    }
    return { path, version, target: `${platform}-${arch}`, directory };
  } catch (error) {
    if (isUnavailable(error)) return undefined;
    throw error;
  }
}
