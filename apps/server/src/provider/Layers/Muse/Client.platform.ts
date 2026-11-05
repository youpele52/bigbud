/**
 * Platform-specific Muse host launch and workspace-root forms.
 *
 * Adapted from upstream t3code's shipped Muse driver (not copied):
 * - Windows: `child_process.spawn` has no shell, so a bare `muse` is resolved
 *   through PATHEXT first; `.cmd`/`.bat` launchers run under ComSpec with `/d`
 *   (no AutoRun output on stdout, which would corrupt the MSP stream) and `/c`.
 *   Paths with whitespace use a bare `@` so cmd keeps the quoted path; other
 *   paths escape cmd metacharacters with `^`.
 * - Windows: Muse accepts only the verbatim canonical root (`\\?\C:\…`, true
 *   on-disk case from the native realpath). The host process itself must start
 *   in the plain path because cmd.exe cannot use a verbatim working directory.
 * - macOS/Linux: the canonical path is already the native form.
 *
 * Official installers (read from dev.meta.ai/install.{sh,ps1} and their
 * launchers, 2026-10-29):
 * - POSIX installs a bash launcher at `${MUSE_INSTALL_DIR:-~/.local/bin}/muse`
 *   that ends in `exec muse-bin-<version>`, so stdio and the SDK's process
 *   group reach the real host directly. It is spawned as-is.
 * - Windows installs `%LOCALAPPDATA%\Programs\muse\muse.cmd`, a shim that
 *   runs Windows PowerShell, which runs `.muse-launcher.ps1`, which calls the
 *   real `muse-bin-<version>.exe` from inside a script function. Three wrapper
 *   processes would sit between bigbud and the host: the SDK's Windows
 *   teardown ends only its direct child, and PowerShell 5.1 may re-encode a
 *   native command's output in the console codepage, which would corrupt
 *   non-ASCII text on the MSP stream. Behind that official shim bigbud
 *   therefore starts the active binary directly, using the launcher's own
 *   rule (`.muse-version` matching its version pattern → `muse-bin-<v>.exe`).
 *   Auto-update is already disabled for owned hosts, so nothing the launcher
 *   would do is skipped except optional release-notice metadata. Any other
 *   `.cmd`/`.bat` still runs through ComSpec as below.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveCommandPath } from "../../../utils/commandPath.ts";

/** The settings default; only this name falls back to the official install location. */
export const MUSE_DEFAULT_BINARY = "muse";
/** Copied from the official launchers (`version_pattern`). */
const MUSE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(\.[0-9]+)?$/;

export interface MuseLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

function windowsEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Where the official installer puts `muse`. Used only when the default name is
 * not on PATH, e.g. bigbud was started before the installer updated PATH
 * (Windows writes the user PATH to the registry; running apps keep the old one).
 */
export function museInstallerCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  if (platform === "win32") {
    const localAppData = windowsEnvironmentValue(env, "LOCALAPPDATA");
    return localAppData ? [join(localAppData, "Programs", "muse", "muse.cmd")] : [];
  }
  const dirs = [env.MUSE_INSTALL_DIR, env.HOME ? join(env.HOME, ".local", "bin") : undefined];
  return dirs.filter((dir): dir is string => Boolean(dir)).map((dir) => join(dir, "muse"));
}

/** The real binary behind the official Windows `muse.cmd` shim, or undefined if the layout differs. */
export function resolveOfficialShimBinary(shimPath: string): string | undefined {
  const dir = dirname(shimPath);
  if (!existsSync(join(dir, ".muse-launcher.ps1"))) return undefined;
  let version: string;
  try {
    version = readFileSync(join(dir, ".muse-version"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (!MUSE_VERSION_PATTERN.test(version)) return undefined;
  const binary = join(dir, `muse-bin-${version}.exe`);
  return existsSync(binary) ? binary : undefined;
}

export function resolveMuseLaunch(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  resolve: (command: string) => string | null = (command) =>
    resolveCommandPath(command, { platform, env }),
  subcommand: ReadonlyArray<string> = ["serve"],
): MuseLaunch {
  const fallback =
    binaryPath === MUSE_DEFAULT_BINARY
      ? museInstallerCandidates(platform, env)
          .map((candidate) => resolve(candidate))
          .find((candidate): candidate is string => candidate !== null)
      : undefined;
  const resolved = resolve(binaryPath) ?? fallback ?? binaryPath;
  if (platform !== "win32") return { command: resolved, args: [...subcommand] };
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { command: resolved, args: [...subcommand] };
  const direct = resolveOfficialShimBinary(resolved);
  if (direct) return { command: direct, args: [...subcommand] };
  const systemRoot = windowsEnvironmentValue(env, "SystemRoot");
  const shell =
    windowsEnvironmentValue(env, "ComSpec") ??
    (systemRoot ? `${systemRoot}\\System32\\cmd.exe` : "cmd.exe");
  const target = /\s/.test(resolved) ? ["@", resolved] : [resolved.replace(/[()&<>@^|]/g, "^$&")];
  return { command: shell, args: ["/d", "/c", ...target, ...subcommand] };
}

/** `C:\x` → `\\?\C:\x`, `\\server\share` → `\\?\UNC\server\share`; already-verbatim stays. */
export function museVerbatimPath(path: string): string {
  if (path.startsWith("\\\\?\\")) return path;
  return path.startsWith("\\\\") ? `\\\\?\\UNC\\${path.slice(2)}` : `\\\\?\\${path}`;
}

/** The root sent on the wire for an already-canonical plain workspace path. */
export function museNativeWorkspaceRoot(
  canonicalWorkspace: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return canonicalWorkspace;
  // A verbatim path takes `/` literally, so normalize separators first.
  return museVerbatimPath(canonicalWorkspace.replaceAll("/", "\\"));
}
