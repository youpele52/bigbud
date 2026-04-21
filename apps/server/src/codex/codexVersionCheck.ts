/**
 * Codex CLI version check with per-process caching.
 *
 * Runs `codex --version` synchronously on first use for a given binary path
 * and caches the result so subsequent session starts within the same process
 * pay no extra cost.
 */

import { spawnSync } from "node:child_process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../provider/codexCliVersion";

/** Maximum time in milliseconds to wait for `codex --version` to respond. */
export const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;

/**
 * Module-level cache for version check results keyed by binary path.
 * Avoids repeating the blocking spawnSync on every new session start.
 * The cache holds a tuple: `[ok: true]` for a passing check, or
 * `[ok: false, message: string]` for a version that previously failed.
 */
const versionCheckCache = new Map<string, [ok: true] | [ok: false, message: string]>();

/**
 * Asserts that the Codex CLI binary at `binaryPath` meets the minimum
 * supported version requirement.  Throws an `Error` with a human-readable
 * upgrade message when the binary is missing, unexecutable, or too old.
 * Results are cached per binary path for the lifetime of the process.
 */
export function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): void {
  const cached = versionCheckCache.get(input.binaryPath);
  if (cached !== undefined) {
    if (!cached[0]) {
      throw new Error(cached[1]);
    }
    return;
  }

  const result = spawnSync(input.binaryPath, ["--version"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      const msg = `Codex CLI (${input.binaryPath}) is not installed or not executable.`;
      versionCheckCache.set(input.binaryPath, [false, msg]);
      throw new Error(msg);
    }
    const msg = `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`;
    versionCheckCache.set(input.binaryPath, [false, msg]);
    throw new Error(msg);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    const msg = `Codex CLI version check failed. ${detail}`;
    versionCheckCache.set(input.binaryPath, [false, msg]);
    throw new Error(msg);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    const msg = formatCodexCliUpgradeMessage(parsedVersion);
    versionCheckCache.set(input.binaryPath, [false, msg]);
    throw new Error(msg);
  }

  versionCheckCache.set(input.binaryPath, [true]);
}
