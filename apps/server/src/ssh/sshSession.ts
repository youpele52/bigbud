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
import { writePasswordAskpassScript } from "./sshSession.askpass.ts";
import { buildSshControlArgs, type SshPasswordSessionRecord } from "./sshSession.control.ts";
import {
  drainOwnedSshMastersWith,
  type OwnedSshMaster,
  type OwnedSshMasterDrain,
} from "./sshSession.ownedMasters.ts";
import {
  assertSshTargetConnected,
  isSshTargetDisconnected,
  RemoteTargetDisconnectedError,
} from "./sshTargetDisconnects.ts";
import {
  buildSshPasswordRequiredMessage,
  SSH_PASSWORD_AUTH_REQUIRED_MESSAGE,
  SshTargetAuthRequiredError,
} from "./sshTargetUnavailable.ts";

const SSH_PASSWORD_SESSION_DIR_PREFIX = "bbs-";
const SSH_PASSWORD_ASKPASS_DIR_PREFIX = "bigbud-ssh-password-askpass-";
// Prefer /tmp: the macOS temp dir can be too long for a Unix-socket ControlPath.
const sessionRootBaseDirectory =
  process.platform === "win32" ? os.tmpdir() : fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
let sessionRootDirectory: string | undefined;
const passwordSessionByExecutionTargetId = new Map<string, SshPasswordSessionRecord>();

function buildPasswordSessionDestination(target: SshExecutionTarget): string {
  return target.port
    ? `${formatSshDestination(target)}:${target.port}`
    : formatSshDestination(target);
}

export function buildPasswordSessionControlPath(executionTargetId: string): string {
  // Key-only and local-only backends do not need a password socket directory.
  sessionRootDirectory ??= fs.mkdtempSync(
    path.join(sessionRootBaseDirectory, SSH_PASSWORD_SESSION_DIR_PREFIX),
  );
  const digest = createHash("sha256").update(executionTargetId).digest("hex").slice(0, 20);
  return path.join(sessionRootDirectory, `s-${digest}`);
}

function getPasswordSessionRecord(target: SshExecutionTarget): SshPasswordSessionRecord {
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
  const result = runSshLocalCommandSync("ssh", buildSshControlArgs("check", target, session), {
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
  const result = await runSshLocalCommand("ssh", buildSshControlArgs("check", target, session), {
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
    return SSH_PASSWORD_AUTH_REQUIRED_MESSAGE;
  }

  return buildSshPasswordRequiredMessage(buildPasswordSessionDestination(target));
}

function passwordRequiredError(target: SshExecutionTarget): SshTargetAuthRequiredError {
  return new SshTargetAuthRequiredError(
    target.executionTargetId,
    "password",
    formatSshPasswordRequiredMessage(target.executionTargetId),
  );
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
    throw passwordRequiredError(target);
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
    throw passwordRequiredError(target);
  }
}

export function buildSshPasswordSessionTransportArgs(input: {
  readonly executionTargetId: string | null | undefined;
  readonly allocateTty?: boolean;
}): string[] {
  assertSshTargetConnected(input.executionTargetId);
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
  assertSshTargetConnected(input.executionTargetId);
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
        "--",
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
    // A Disconnect that landed during the unlock has already run its teardown: end this master.
    if (isSshTargetDisconnected(target.executionTargetId)) {
      await closeSshPasswordSession(target.executionTargetId);
      throw new RemoteTargetDisconnectedError(target.executionTargetId);
    }

    return {
      message: `SSH password session for ${buildPasswordSessionDestination(target)} is ready to use.`,
    };
  } finally {
    fs.rmSync(askpassDirectory, { recursive: true, force: true });
  }
}

/**
 * Closes the password ControlMaster for one target (`ssh -O exit`, bounded) and forgets
 * the session, so the next use requires the password again. A missing socket is a no-op.
 */
export async function closeSshPasswordSession(executionTargetId: string): Promise<void> {
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target || sessionRootDirectory === undefined) return;
  const session = passwordSessionByExecutionTargetId.get(target.executionTargetId) ?? {
    controlPath: buildPasswordSessionControlPath(target.executionTargetId),
    destination: formatSshDestination(target),
  };
  try {
    if (fs.existsSync(session.controlPath)) {
      await runSshLocalCommand("ssh", buildSshControlArgs("exit", target, session), {
        timeoutMs: SSH_LOCAL_PROBE_TIMEOUT_MS,
      });
    }
  } finally {
    forgetPasswordSession(target, session.controlPath);
  }
}

function closeAllPasswordSessions(): void {
  for (const [executionTargetId, session] of passwordSessionByExecutionTargetId.entries()) {
    const target = parseSshExecutionTarget(executionTargetId);
    if (target) {
      // Runs from the process `exit` handler, so it must stay synchronous; bounded per session.
      runSshLocalCommandSync("ssh", buildSshControlArgs("exit", target, session), {
        timeoutMs: SSH_LOCAL_PROBE_TIMEOUT_MS,
      });
    }
    fs.rmSync(session.controlPath, { force: true });
  }
  passwordSessionByExecutionTargetId.clear();
  if (sessionRootDirectory !== undefined) {
    fs.rmSync(sessionRootDirectory, { recursive: true, force: true });
  }
}

/** The masters recorded by this process; never discovered from disk or user config. */
export function listOwnedSshMasters(): ReadonlyArray<OwnedSshMaster> {
  return [...passwordSessionByExecutionTargetId.entries()].map(([executionTargetId, session]) => ({
    executionTargetId,
    controlPath: session.controlPath,
    destination: session.destination,
  }));
}

/** Drain-on-quit: exits only the password masters recorded in this process. */
export function drainOwnedSshMasters(): Promise<OwnedSshMasterDrain> {
  return drainOwnedSshMastersWith(listOwnedSshMasters(), {
    forget: (master) => {
      const target = parseSshExecutionTarget(master.executionTargetId);
      if (target) forgetPasswordSession(target, master.controlPath);
    },
  });
}

process.once("exit", closeAllPasswordSessions);
