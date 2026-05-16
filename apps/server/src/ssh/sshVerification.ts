import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildSshCommandInvocation } from "./sshCommand.ts";
import {
  expandSshKeyPath,
  formatSshDestination,
  parseSshExecutionTarget,
} from "./sshExecutionTarget.ts";
import { runProcess } from "../utils/processRunner.ts";

const SSH_VERIFY_TIMEOUT_MS = 8_000;
const SSH_UNLOCK_ASKPASS_DIR_PREFIX = "bigbud-ssh-askpass-";
const SSH_AGENT_ENV_PATTERN = /^(SSH_AUTH_SOCK|SSH_AGENT_PID)=([^;]+);/gm;

export function formatSshKeyLoadMessage(keyPath: string): string {
  return `SSH key '${keyPath}' requires a passphrase. Load it into ssh-agent with 'ssh-add ${keyPath}' before using this target.`;
}

function runLocalCommand(command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
    shell: process.platform === "win32",
  });
}

function createSshAgentEnvFromOutput(stdout: string): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {};
  for (const match of stdout.matchAll(SSH_AGENT_ENV_PATTERN)) {
    const [, key, value] = match;
    if (key && value) {
      nextEnv[key] = value;
    }
  }
  return nextEnv;
}

function ensureSshAgentEnv(): NodeJS.ProcessEnv {
  const existingSocket = process.env.SSH_AUTH_SOCK?.trim();
  if (existingSocket) {
    const existingAgentProbe = runLocalCommand("ssh-add", ["-l"], process.env);
    const existingAgentDetail = `${existingAgentProbe.stderr ?? ""}`.trim();
    if (
      existingAgentProbe.status === 0 ||
      /the agent has no identities/i.test(existingAgentDetail) ||
      /error fetching identities for protocol 1/i.test(existingAgentDetail)
    ) {
      return process.env;
    }
  }

  const result = runLocalCommand("ssh-agent", ["-s"]);
  if (result.error) {
    const detail = result.error instanceof Error ? result.error.message : String(result.error);
    throw new Error(`Failed to start ssh-agent. ${detail}`);
  }

  if (result.status !== 0) {
    const detail =
      `${result.stderr ?? ""}`.trim() ||
      `${result.stdout ?? ""}`.trim() ||
      `Command exited with code ${result.status}.`;
    throw new Error(`Failed to start ssh-agent. ${detail}`);
  }

  const nextEnv = createSshAgentEnvFromOutput(result.stdout);
  const nextSocket = nextEnv.SSH_AUTH_SOCK?.trim();
  if (!nextSocket) {
    throw new Error("Failed to start ssh-agent. Missing SSH_AUTH_SOCK.");
  }

  process.env.SSH_AUTH_SOCK = nextSocket;
  if (nextEnv.SSH_AGENT_PID) {
    process.env.SSH_AGENT_PID = nextEnv.SSH_AGENT_PID;
  }

  return process.env;
}

function isPassphraseProtectedKeyLoaded(expandedKeyPath: string): boolean {
  const publicKeyPath = `${expandedKeyPath}.pub`;
  if (!fs.existsSync(publicKeyPath)) {
    return false;
  }

  const directProbe = runLocalCommand("ssh-add", ["-T", publicKeyPath], process.env);
  if (directProbe.status === 0) {
    return true;
  }

  const listedKeys = runLocalCommand("ssh-add", ["-L"], process.env);
  if (listedKeys.status !== 0) {
    return false;
  }

  const publicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
  return publicKey.length > 0 && listedKeys.stdout.includes(publicKey);
}

export function assertSshExecutionTargetReady(executionTargetId: string | null | undefined): void {
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${executionTargetId ?? "local"}'.`);
  }

  if (target.authMode === "password") {
    throw new Error("Password SSH authentication is not supported for remote execution yet.");
  }

  if (!target.keyPath) {
    return;
  }

  const expandedKeyPath = expandSshKeyPath(target.keyPath);
  if (!fs.existsSync(expandedKeyPath)) {
    throw new Error(`SSH key not found at '${target.keyPath}'.`);
  }

  const keyProbe = runLocalCommand("ssh-keygen", ["-y", "-P", "", "-f", expandedKeyPath]);
  if (keyProbe.error) {
    const detail =
      keyProbe.error instanceof Error ? keyProbe.error.message : String(keyProbe.error);
    throw new Error(`Failed to inspect SSH key '${target.keyPath}'. ${detail}`);
  }

  if (keyProbe.status === 0) {
    return;
  }

  const stderr = `${keyProbe.stderr ?? ""}`.trim();
  if (/incorrect passphrase/i.test(stderr)) {
    if (isPassphraseProtectedKeyLoaded(expandedKeyPath)) {
      return;
    }
    throw new Error(formatSshKeyLoadMessage(target.keyPath));
  }

  const detail =
    stderr || `${keyProbe.stdout ?? ""}`.trim() || `Command exited with code ${keyProbe.status}.`;
  throw new Error(`Failed to read SSH key '${target.keyPath}'. ${detail}`);
}

function writeAskpassScript(directoryPath: string): string {
  const scriptPath = path.join(directoryPath, "askpass.sh");
  fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s\\n" "$BIGBUD_SSH_KEY_PASSPHRASE"\n', "utf8");
  fs.chmodSync(scriptPath, 0o700);
  return scriptPath;
}

export async function unlockSshExecutionTargetKey(input: {
  readonly executionTargetId: string;
  readonly passphrase: string;
}): Promise<{ readonly message: string }> {
  const target = parseSshExecutionTarget(input.executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${input.executionTargetId}'.`);
  }
  if (target.authMode === "password") {
    throw new Error("Password SSH authentication is not supported for remote execution yet.");
  }
  if (!target.keyPath) {
    throw new Error("This SSH target does not have a key path to unlock.");
  }

  const expandedKeyPath = expandSshKeyPath(target.keyPath);
  if (!fs.existsSync(expandedKeyPath)) {
    throw new Error(`SSH key not found at '${target.keyPath}'.`);
  }

  const sshAgentEnv = ensureSshAgentEnv();
  const askpassDirectory = fs.mkdtempSync(path.join(os.tmpdir(), SSH_UNLOCK_ASKPASS_DIR_PREFIX));
  try {
    const askpassScriptPath = writeAskpassScript(askpassDirectory);
    const result = runLocalCommand("ssh-add", [expandedKeyPath], {
      ...sshAgentEnv,
      BIGBUD_SSH_KEY_PASSPHRASE: input.passphrase,
      SSH_ASKPASS: askpassScriptPath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || "bigbud:0",
    });

    if (result.error) {
      const detail = result.error instanceof Error ? result.error.message : String(result.error);
      throw new Error(`Failed to unlock SSH key '${target.keyPath}'. ${detail}`);
    }

    if (result.status !== 0) {
      const detail =
        `${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim() || "Unknown error.";
      if (/bad passphrase|incorrect passphrase/i.test(detail)) {
        throw new Error(`Incorrect passphrase for SSH key '${target.keyPath}'.`);
      }
      throw new Error(`Failed to unlock SSH key '${target.keyPath}'. ${detail}`);
    }

    if (!isPassphraseProtectedKeyLoaded(expandedKeyPath)) {
      throw new Error(
        `Failed to unlock SSH key '${target.keyPath}'. ssh-agent did not retain the key.`,
      );
    }

    return {
      message: `SSH key '${target.keyPath}' is unlocked and ready to use.`,
    };
  } finally {
    fs.rmSync(askpassDirectory, { recursive: true, force: true });
  }
}

export async function verifySshExecutionTarget(input: {
  readonly executionTargetId: string;
  readonly cwd?: string;
}): Promise<{
  readonly executionTargetId: string;
  readonly message: string;
  readonly cwd?: string;
}> {
  assertSshExecutionTargetReady(input.executionTargetId);

  const target = parseSshExecutionTarget(input.executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${input.executionTargetId}'.`);
  }

  const invocation = buildSshCommandInvocation({
    executionTargetId: input.executionTargetId,
    command: "pwd",
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  const result = await runProcess(invocation.command, invocation.args, {
    timeoutMs: SSH_VERIFY_TIMEOUT_MS,
    maxBufferBytes: 64 * 1024,
    outputMode: "truncate",
  });

  const verifiedCwd = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reduce<string | undefined>(
      (lastNonEmptyLine, line) => (line.length > 0 ? line : lastNonEmptyLine),
      undefined,
    );
  const targetLabel = target.port
    ? `${formatSshDestination(target)}:${target.port}`
    : formatSshDestination(target);

  return {
    executionTargetId: target.executionTargetId,
    message: verifiedCwd
      ? `Connected to ${targetLabel}. Remote path resolved to ${verifiedCwd}.`
      : `Connected to ${targetLabel}.`,
    ...(verifiedCwd ? { cwd: verifiedCwd } : {}),
  };
}
