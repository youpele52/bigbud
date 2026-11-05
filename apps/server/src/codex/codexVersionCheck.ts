/**
 * Fresh Codex CLI version check for each new process. Existing sessions keep their binding.
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
 * Asserts that the Codex CLI binary at `binaryPath` meets the minimum
 * supported version requirement.  Throws an `Error` with a human-readable
 * upgrade message when the binary is missing, unexecutable, or too old.
 * Rechecks changed binaries, PATH resolution, homes, and configurations on future starts.
 */
export function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): string | undefined {
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
      throw new Error(msg);
    }
    const msg = `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`;
    throw new Error(msg);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    const msg = `Codex CLI version check failed. ${detail}`;
    throw new Error(msg);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    const msg = formatCodexCliUpgradeMessage(parsedVersion);
    throw new Error(msg);
  }

  return parsedVersion ?? undefined;
}
