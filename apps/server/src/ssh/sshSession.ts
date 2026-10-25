import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectSshHostTrust } from "./sshHostTrust.ts";
import {
  createSshDeadline,
  describeSshLocalCommandFailure,
  runSshLocalCommand,
  runSshLocalCommandSync,
  SSH_CONNECT_TIMEOUT_SECONDS,
  SSH_LOCAL_PROBE_TIMEOUT_MS,
  type SshDeadline,
  SSH_UNLOCK_DEADLINE_MS,
} from "./sshLocalCommand.ts";
import {
  formatSshDestination,
  parseSshExecutionTarget,
  type SshExecutionTarget,
} from "./sshExecutionTarget.ts";

const SSH_PASSWORD_SESSION_DIR_PREFIX = "bbs-";
const SSH_PASSWORD_ASKPASS_DIR_PREFIX = "bigbud-ssh-password-askpass-";
// Keep the SSH ControlPath short to avoid hitting Unix socket path limits.
// `os.tmpdir()` can be very long on macOS (e.g. `/var/folders/...`), so prefer
// `/tmp` when available.
const sessionRootBaseDirectory =
  process.platform === "win32" ? os.tmpdir() : fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
const sessionRootDirectory = fs.mkdtempSync(
  path.join(sessionRootBaseDirectory, SSH_PASSWORD_SESSION_DIR_PREFIX),
);
const passwordSessionByExecutionTargetId = new Map<
  string,
  {
    readonly controlPath: string;
    readonly destination: string;
  }
>();

function writePasswordAskpassScript(directoryPath: string): string {
  const scriptPath = path.join(directoryPath, "askpass.sh");
  fs.writeFileSync(
    scriptPath,
    '#!/bin/sh\ncase "$1" in\n  *authenticity*|*fingerprint*) exit 1 ;;\n  *[Pp]assword*|*[Pp]asscode*) printf "%s\\n" "$BIGBUD_SSH_PASSWORD" ;;\n  *) exit 1 ;;\nesac\n',
    "utf8",
  );
  fs.chmodSync(scriptPath, 0o700);
  return scriptPath;
}

function buildPasswordSessionDestination(target: SshExecutionTarget): string {
  return target.port
    ? `${formatSshDestination(target)}:${target.port}`
    : formatSshDestination(target);
}

export function buildPasswordSessionControlPath(executionTargetId: string): string {
  const digest = createHash("sha256").update(executionTargetId).digest("hex").slice(0, 20);
  return path.join(sessionRootDirectory, `s-${digest}`);
}

function getPasswordSessionRecord(target: SshExecutionTarget): {
  readonly controlPath: string;
  readonly destination: string;
} {
  const existing = passwordSessionByExecutionTargetId.get(target.executionTargetId);
  if (existing) {
    return existing;
  }

  const controlPath = buildPasswordSessionControlPath(target.executionTargetId);
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

function buildControlCheckArgs(
  target: SshExecutionTarget,
  session: { readonly controlPath: string; readonly destination: string },
): string[] {
  return [
    "-O",
    "check",
    "-o",
    `ControlPath=${session.controlPath}`,
    ...(target.port ? ["-p", target.port] : []),
    session.destination,
  ];
}

/**
 * A control-master check that passed this recently is not repeated, so an
 * async readiness check followed by building the command's transport args does
 * not fall back to a synchronous probe.
 */
const PASSWORD_SESSION_CHECK_FRESH_MS = 10_000;
const passwordSessionCheckedAt = new Map<string, number>();

function isPasswordSessionCheckFresh(target: SshExecutionTarget): boolean {
  const checkedAt = passwordSessionCheckedAt.get(target.executionTargetId);
  const session = passwordSessionByExecutionTargetId.get(target.executionTargetId);
  return (
    checkedAt !== undefined &&
    performance.now() - checkedAt < PASSWORD_SESSION_CHECK_FRESH_MS &&
    session !== undefined &&
    fs.existsSync(session.controlPath)
  );
}

function recordPasswordSessionCheck(target: SshExecutionTarget, active: boolean): boolean {
  if (active) passwordSessionCheckedAt.set(target.executionTargetId, performance.now());
  return active;
}

function forgetPasswordSession(target: SshExecutionTarget, controlPath: string): void {
  fs.rmSync(controlPath, { force: true });
  passwordSessionByExecutionTargetId.delete(target.executionTargetId);
  passwordSessionCheckedAt.delete(target.executionTargetId);
}

/** Synchronous control-master check for synchronous readiness callers; bounded by a short timeout. */
function isPasswordSessionActive(target: SshExecutionTarget): boolean {
  const session = passwordSessionByExecutionTargetId.get(target.executionTargetId);
  if (!session || !fs.existsSync(session.controlPath)) {
    return false;
  }
  const result = runSshLocalCommandSync("ssh", buildControlCheckArgs(target, session), {
    timeoutMs: SSH_LOCAL_PROBE_TIMEOUT_MS,
  });
  if (result.status === 0) {
    return recordPasswordSessionCheck(target, true);
  }
  forgetPasswordSession(target, session.controlPath);
  return false;
}

async function isPasswordSessionActiveAsync(
  target: SshExecutionTarget,
  timeoutMs: number,
): Promise<boolean> {
  const session = passwordSessionByExecutionTargetId.get(target.executionTargetId);
  if (!session || !fs.existsSync(session.controlPath)) {
    return false;
  }
  const result = await runSshLocalCommand("ssh", buildControlCheckArgs(target, session), {
    timeoutMs,
  });
  if (result.status === 0) {
    return recordPasswordSessionCheck(target, true);
  }
  forgetPasswordSession(target, session.controlPath);
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
  if (target.authMode !== "password" || isPasswordSessionCheckFresh(target)) {
    return;
  }
  if (!isPasswordSessionActive(target)) {
    throw new Error(formatSshPasswordRequiredMessage(target.executionTargetId));
  }
}

/** Async readiness for password targets: the control-master check never blocks the event loop. */
export async function assertSshPasswordExecutionTargetReadyAsync(
  executionTargetId: string | null | undefined,
  deadline: SshDeadline,
): Promise<void> {
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${executionTargetId ?? "local"}'.`);
  }
  if (target.authMode !== "password" || isPasswordSessionCheckFresh(target)) {
    return;
  }
  if (
    !(await isPasswordSessionActiveAsync(target, deadline.remainingMs(SSH_LOCAL_PROBE_TIMEOUT_MS)))
  ) {
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

  const deadline = createSshDeadline();
  if (
    await isPasswordSessionActiveAsync(target, deadline.remainingMs(SSH_LOCAL_PROBE_TIMEOUT_MS))
  ) {
    return {
      message: `SSH password session for ${buildPasswordSessionDestination(target)} is ready to use.`,
    };
  }

  await inspectSshHostTrust(target.executionTargetId);
  const session = getPasswordSessionRecord(target);
  fs.rmSync(session.controlPath, { force: true });
  const askpassDirectory = fs.mkdtempSync(path.join(os.tmpdir(), SSH_PASSWORD_ASKPASS_DIR_PREFIX));
  try {
    const askpassScriptPath = writePasswordAskpassScript(askpassDirectory);
    const result = await runSshLocalCommand(
      "ssh",
      [
        "-f",
        "-N",
        "-o",
        "BatchMode=no",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
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
        env: {
          ...process.env,
          BIGBUD_SSH_PASSWORD: input.password,
          SSH_ASKPASS: askpassScriptPath,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: process.env.DISPLAY || "bigbud:0",
        },
        timeoutMs: deadline.remainingMs(),
      },
    );

    if (result.timedOut) {
      fs.rmSync(session.controlPath, { force: true });
      throw new Error(
        `Timed out after ${SSH_UNLOCK_DEADLINE_MS / 1000} s connecting to ${buildPasswordSessionDestination(target)}.`,
      );
    }

    if (result.error) {
      throw new Error(
        `Failed to unlock SSH password session. ${describeSshLocalCommandFailure(result)}`,
      );
    }

    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "Unknown error.";
      if (/permission denied/i.test(detail)) {
        throw new Error(`Incorrect password for ${buildPasswordSessionDestination(target)}.`);
      }
      throw new Error(`Failed to unlock SSH password session. ${detail}`);
    }

    if (
      !(await isPasswordSessionActiveAsync(
        target,
        Math.max(1, deadline.remainingMs(SSH_LOCAL_PROBE_TIMEOUT_MS)),
      ))
    ) {
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
      // Runs from the process `exit` handler, so it must stay synchronous; bounded per session.
      runSshLocalCommandSync(
        "ssh",
        [
          "-O",
          "exit",
          "-o",
          `ControlPath=${session.controlPath}`,
          ...(target.port ? ["-p", target.port] : []),
          session.destination,
        ],
        { timeoutMs: SSH_LOCAL_PROBE_TIMEOUT_MS },
      );
    }
    fs.rmSync(session.controlPath, { force: true });
  }
  passwordSessionByExecutionTargetId.clear();
  fs.rmSync(sessionRootDirectory, { recursive: true, force: true });
}

process.once("exit", closeAllPasswordSessions);
