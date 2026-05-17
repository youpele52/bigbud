import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  formatSshDestination,
  parseSshExecutionTarget,
  type SshExecutionTarget,
} from "./sshExecutionTarget.ts";

const SSH_PASSWORD_SESSION_DIR_PREFIX = "bigbud-ssh-session-";
const SSH_PASSWORD_ASKPASS_DIR_PREFIX = "bigbud-ssh-password-askpass-";
const sessionRootDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), SSH_PASSWORD_SESSION_DIR_PREFIX),
);
const passwordSessionByExecutionTargetId = new Map<
  string,
  {
    readonly controlPath: string;
    readonly destination: string;
  }
>();

function runLocalCommand(command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
    shell: process.platform === "win32",
  });
}

function writePasswordAskpassScript(directoryPath: string): string {
  const scriptPath = path.join(directoryPath, "askpass.sh");
  fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s\\n" "$BIGBUD_SSH_PASSWORD"\n', "utf8");
  fs.chmodSync(scriptPath, 0o700);
  return scriptPath;
}

function buildPasswordSessionDestination(target: SshExecutionTarget): string {
  return target.port
    ? `${formatSshDestination(target)}:${target.port}`
    : formatSshDestination(target);
}

function getPasswordSessionRecord(target: SshExecutionTarget): {
  readonly controlPath: string;
  readonly destination: string;
} {
  const existing = passwordSessionByExecutionTargetId.get(target.executionTargetId);
  if (existing) {
    return existing;
  }

  const controlPath = path.join(
    sessionRootDirectory,
    `ssh-${Buffer.from(target.executionTargetId).toString("base64url")}.sock`,
  );
  const record = {
    controlPath,
    destination: formatSshDestination(target),
  } as const;
  passwordSessionByExecutionTargetId.set(target.executionTargetId, record);
  return record;
}

function buildPasswordTransportArgs(input: {
  readonly target: SshExecutionTarget;
  readonly controlPath: string;
  readonly allocateTty?: boolean;
}): string[] {
  return [
    ...(input.allocateTty ? ["-tt"] : ["-T"]),
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    `ControlPath=${input.controlPath}`,
    ...(input.target.port ? ["-p", input.target.port] : []),
  ];
}

function isPasswordSessionActive(target: SshExecutionTarget): boolean {
  const session = passwordSessionByExecutionTargetId.get(target.executionTargetId);
  if (!session || !fs.existsSync(session.controlPath)) {
    return false;
  }

  const result = runLocalCommand("ssh", [
    "-O",
    "check",
    "-o",
    `ControlPath=${session.controlPath}`,
    ...(target.port ? ["-p", target.port] : []),
    session.destination,
  ]);

  if (result.status === 0) {
    return true;
  }

  fs.rmSync(session.controlPath, { force: true });
  passwordSessionByExecutionTargetId.delete(target.executionTargetId);
  return false;
}

export function formatSshPasswordRequiredMessage(executionTargetId: string): string {
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target) {
    return "SSH password authentication is required before using this target.";
  }

  return `SSH password is required for ${buildPasswordSessionDestination(target)}. Re-enter it before using this target.`;
}

export function assertSshPasswordExecutionTargetReady(
  executionTargetId: string | null | undefined,
): void {
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${executionTargetId ?? "local"}'.`);
  }
  if (target.authMode !== "password") {
    return;
  }
  if (!isPasswordSessionActive(target)) {
    throw new Error(formatSshPasswordRequiredMessage(target.executionTargetId));
  }
}

export function buildSshPasswordSessionTransportArgs(input: {
  readonly executionTargetId: string | null | undefined;
  readonly allocateTty?: boolean;
}): string[] {
  const target = parseSshExecutionTarget(input.executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${input.executionTargetId ?? "local"}'.`);
  }
  if (target.authMode !== "password") {
    throw new Error("Password SSH authentication is not enabled for this execution target.");
  }

  assertSshPasswordExecutionTargetReady(target.executionTargetId);
  const session = getPasswordSessionRecord(target);
  return buildPasswordTransportArgs({
    target,
    controlPath: session.controlPath,
    ...(input.allocateTty !== undefined ? { allocateTty: input.allocateTty } : {}),
  });
}

export async function unlockSshExecutionTargetPassword(input: {
  readonly executionTargetId: string;
  readonly password: string;
}): Promise<{ readonly message: string }> {
  const target = parseSshExecutionTarget(input.executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${input.executionTargetId}'.`);
  }
  if (target.authMode !== "password") {
    throw new Error("This SSH target is not configured for password authentication.");
  }

  if (isPasswordSessionActive(target)) {
    return {
      message: `SSH password session for ${buildPasswordSessionDestination(target)} is ready to use.`,
    };
  }

  const session = getPasswordSessionRecord(target);
  fs.rmSync(session.controlPath, { force: true });
  const askpassDirectory = fs.mkdtempSync(path.join(os.tmpdir(), SSH_PASSWORD_ASKPASS_DIR_PREFIX));
  try {
    const askpassScriptPath = writePasswordAskpassScript(askpassDirectory);
    const result = runLocalCommand(
      "ssh",
      [
        "-f",
        "-N",
        "-o",
        "BatchMode=no",
        "-o",
        "ControlMaster=yes",
        "-o",
        "ControlPersist=600",
        "-o",
        `ControlPath=${session.controlPath}`,
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "PreferredAuthentications=password,keyboard-interactive",
        "-o",
        "PubkeyAuthentication=no",
        ...(target.port ? ["-p", target.port] : []),
        session.destination,
      ],
      {
        ...process.env,
        BIGBUD_SSH_PASSWORD: input.password,
        SSH_ASKPASS: askpassScriptPath,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || "bigbud:0",
      },
    );

    if (result.error) {
      const detail = result.error instanceof Error ? result.error.message : String(result.error);
      throw new Error(`Failed to unlock SSH password session. ${detail}`);
    }

    if (result.status !== 0) {
      const detail =
        `${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim() || "Unknown error.";
      if (/permission denied/i.test(detail)) {
        throw new Error(`Incorrect password for ${buildPasswordSessionDestination(target)}.`);
      }
      throw new Error(`Failed to unlock SSH password session. ${detail}`);
    }

    if (!isPasswordSessionActive(target)) {
      throw new Error("Failed to unlock SSH password session. SSH did not retain the connection.");
    }

    return {
      message: `SSH password session for ${buildPasswordSessionDestination(target)} is ready to use.`,
    };
  } finally {
    fs.rmSync(askpassDirectory, { recursive: true, force: true });
  }
}

function closeAllPasswordSessions(): void {
  for (const [executionTargetId, session] of passwordSessionByExecutionTargetId.entries()) {
    const target = parseSshExecutionTarget(executionTargetId);
    if (target) {
      runLocalCommand("ssh", [
        "-O",
        "exit",
        "-o",
        `ControlPath=${session.controlPath}`,
        ...(target.port ? ["-p", target.port] : []),
        session.destination,
      ]);
    }
    fs.rmSync(session.controlPath, { force: true });
  }
  passwordSessionByExecutionTargetId.clear();
  fs.rmSync(sessionRootDirectory, { recursive: true, force: true });
}

process.once("exit", closeAllPasswordSessions);
