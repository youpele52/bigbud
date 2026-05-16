import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../provider/codexCliVersion.ts";
import { buildSshCommandInvocation } from "../ssh/sshCommand.ts";
import { assertSshExecutionTargetReady } from "../ssh/sshVerification.ts";
import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";

const remoteVersionCheckCache = new Set<string>();
const SSH_VERSION_CHECK_TIMEOUT_MS = 8_000;

export interface SshInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export function buildRemoteCodexSshInvocation(
  input: CodexAppServerStartSessionInput,
  commandArgs: ReadonlyArray<string>,
): SshInvocation {
  const remoteCwd = input.cwd?.trim();
  if (!remoteCwd) {
    throw new Error("Remote Codex sessions require a remote workspace path.");
  }

  return buildSshCommandInvocation({
    executionTargetId: input.executionTargetId,
    cwd: remoteCwd,
    command: input.binaryPath,
    args: commandArgs,
    ...(input.homePath ? { env: { CODEX_HOME: input.homePath } } : {}),
  });
}

function readRemoteVersionCacheKey(input: CodexAppServerStartSessionInput): string {
  return [input.executionTargetId ?? "", input.binaryPath, input.homePath ?? ""].join("::");
}

export function assertSupportedRemoteCodexCliVersion(input: CodexAppServerStartSessionInput): void {
  const cacheKey = readRemoteVersionCacheKey(input);
  if (remoteVersionCheckCache.has(cacheKey)) {
    return;
  }

  assertSshExecutionTargetReady(input.executionTargetId);
  const invocation = buildRemoteCodexSshInvocation(input, ["--version"]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SSH_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    const message =
      lower.includes("enoent") || lower.includes("not found")
        ? "SSH client (ssh) is not installed or not executable."
        : `Failed to execute remote Codex CLI version check: ${result.error.message || String(result.error)}`;
    throw new Error(message);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Remote Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }

  remoteVersionCheckCache.add(cacheKey);
}

export function startRemoteCodexAppServerProcess(
  input: CodexAppServerStartSessionInput,
): ChildProcessWithoutNullStreams {
  assertSupportedRemoteCodexCliVersion(input);
  const invocation = buildRemoteCodexSshInvocation(input, ["app-server"]);
  return spawn(invocation.command, invocation.args, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}
