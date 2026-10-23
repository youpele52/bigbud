import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureSshAgentEnv,
  isPassphraseProtectedKeyLoaded,
  isPassphraseProtectedKeyLoadedAsync,
} from "./sshAgent.ts";
import { buildSshCommandInvocation } from "./sshCommand.ts";
import {
  expandSshKeyPath,
  formatSshDestination,
  parseSshExecutionTarget,
} from "./sshExecutionTarget.ts";
import {
  assertSshPasswordExecutionTargetReady,
  assertSshPasswordExecutionTargetReadyAsync,
  formatSshPasswordRequiredMessage,
  unlockSshExecutionTargetPassword,
} from "./sshSession.ts";
import {
  createSshDeadline,
  describeSshLocalCommandFailure,
  runSshLocalCommand,
  runSshLocalCommandSync,
  type SshDeadline,
  type SshLocalCommandResult,
  SSH_LOCAL_PROBE_TIMEOUT_MS,
  SSH_READINESS_DEADLINE_MS,
  SSH_UNLOCK_DEADLINE_MS,
} from "./sshLocalCommand.ts";
import { runProcess } from "../utils/processRunner.ts";
import { inspectSshHostTrustOnFailure } from "./sshHostTrust.ts";

const SSH_VERIFY_TIMEOUT_MS = 8_000;
const SSH_UNLOCK_ASKPASS_DIR_PREFIX = "bigbud-ssh-askpass-";

export function formatSshKeyLoadMessage(keyPath: string): string {
  return `SSH key '${keyPath}' requires a passphrase. Load it into ssh-agent with 'ssh-add ${keyPath}' before using this target.`;
}

type KeyTarget = { readonly keyPath: string; readonly expandedKeyPath: string };

/** Parses the target; returns the key to probe, or `undefined` when no local probe is needed. */
function resolveKeyTarget(executionTargetId: string | null | undefined): KeyTarget | undefined {
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${executionTargetId ?? "local"}'.`);
  }
  if (target.authMode === "password" || !target.keyPath) {
    return undefined;
  }
  const expandedKeyPath = expandSshKeyPath(target.keyPath);
  if (!fs.existsSync(expandedKeyPath)) {
    throw new Error(`SSH key not found at '${target.keyPath}'.`);
  }
  return { keyPath: target.keyPath, expandedKeyPath };
}

function keyProbeArgs(key: KeyTarget): string[] {
  return ["-y", "-P", "", "-f", key.expandedKeyPath];
}

/**
 * Interprets `ssh-keygen -y`: `false` when the key is usable as is, `true`
 * when it is passphrase protected and must be loaded in ssh-agent; throws otherwise.
 */
function keyNeedsAgent(key: KeyTarget, keyProbe: SshLocalCommandResult): boolean {
  if (keyProbe.timedOut) {
    throw new Error(`Timed out inspecting SSH key '${key.keyPath}'.`);
  }
  if (keyProbe.error) {
    throw new Error(`Failed to inspect SSH key '${key.keyPath}'. ${keyProbe.error.message}`);
  }
  if (keyProbe.status === 0) {
    return false;
  }
  const stderr = keyProbe.stderr.trim();
  if (/incorrect passphrase/i.test(stderr)) {
    return true;
  }
  const detail = stderr || keyProbe.stdout.trim() || `Command exited with code ${keyProbe.status}.`;
  throw new Error(`Failed to read SSH key '${key.keyPath}'. ${detail}`);
}

/**
 * Synchronous readiness check, kept only for callers that cannot await. Each
 * local probe is bounded, but the chain can still block the event loop for
 * several seconds; prefer `assertSshExecutionTargetReadyAsync`.
 */
export function assertSshExecutionTargetReady(executionTargetId: string | null | undefined): void {
  assertSshPasswordExecutionTargetReady(executionTargetId);
  const key = resolveKeyTarget(executionTargetId);
  if (!key) return;
  const keyProbe = runSshLocalCommandSync("ssh-keygen", keyProbeArgs(key), {
    timeoutMs: SSH_LOCAL_PROBE_TIMEOUT_MS,
  });
  if (keyNeedsAgent(key, keyProbe) && !isPassphraseProtectedKeyLoaded(key.expandedKeyPath)) {
    throw new Error(formatSshKeyLoadMessage(key.keyPath));
  }
}

/** Bounded async local readiness probes; missing credentials first trigger host-identity discovery. */
export async function assertSshExecutionTargetReadyAsync(
  executionTargetId: string | null | undefined,
  deadline: SshDeadline = createSshDeadline(SSH_READINESS_DEADLINE_MS),
): Promise<void> {
  try {
    await assertSshPasswordExecutionTargetReadyAsync(executionTargetId, deadline);
    const key = resolveKeyTarget(executionTargetId);
    if (!key) return;
    const keyProbe = await runSshLocalCommand("ssh-keygen", keyProbeArgs(key), {
      timeoutMs: deadline.remainingMs(SSH_LOCAL_PROBE_TIMEOUT_MS),
    });
    if (
      keyNeedsAgent(key, keyProbe) &&
      !(await isPassphraseProtectedKeyLoadedAsync(key.expandedKeyPath, deadline))
    ) {
      throw new Error(formatSshKeyLoadMessage(key.keyPath));
    }
  } catch (error) {
    return inspectSshHostTrustOnFailure(executionTargetId ?? "local", error);
  }
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

  const deadline = createSshDeadline();
  const sshAgentEnv = await ensureSshAgentEnv(deadline);
  const askpassDirectory = fs.mkdtempSync(path.join(os.tmpdir(), SSH_UNLOCK_ASKPASS_DIR_PREFIX));
  try {
    const askpassScriptPath = writeAskpassScript(askpassDirectory);
    const result = await runSshLocalCommand("ssh-add", [expandedKeyPath], {
      env: {
        ...sshAgentEnv,
        BIGBUD_SSH_KEY_PASSPHRASE: input.passphrase,
        SSH_ASKPASS: askpassScriptPath,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || "bigbud:0",
      },
      timeoutMs: deadline.remainingMs(),
    });

    if (result.timedOut) {
      throw new Error(
        `Timed out after ${SSH_UNLOCK_DEADLINE_MS / 1000} s unlocking SSH key '${target.keyPath}'.`,
      );
    }

    if (result.error) {
      throw new Error(
        `Failed to unlock SSH key '${target.keyPath}'. ${describeSshLocalCommandFailure(result)}`,
      );
    }

    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "Unknown error.";
      if (/bad passphrase|incorrect passphrase/i.test(detail)) {
        throw new Error(`Incorrect passphrase for SSH key '${target.keyPath}'.`);
      }
      throw new Error(`Failed to unlock SSH key '${target.keyPath}'. ${detail}`);
    }

    if (!(await isPassphraseProtectedKeyLoadedAsync(expandedKeyPath, deadline))) {
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
  await assertSshExecutionTargetReadyAsync(input.executionTargetId);

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
  }).catch((error: unknown) => inspectSshHostTrustOnFailure(input.executionTargetId, error));

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

export async function unlockSshExecutionTargetCredential(input: {
  readonly executionTargetId: string;
  readonly secret: string;
}): Promise<{ readonly message: string }> {
  const target = parseSshExecutionTarget(input.executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${input.executionTargetId}'.`);
  }

  if (target.authMode === "password") {
    return unlockSshExecutionTargetPassword({
      executionTargetId: target.executionTargetId,
      password: input.secret,
    });
  }

  return unlockSshExecutionTargetKey({
    executionTargetId: target.executionTargetId,
    passphrase: input.secret,
  });
}

export { formatSshPasswordRequiredMessage };
