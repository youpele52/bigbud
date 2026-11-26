import { posix } from "node:path";
import type { Readable } from "node:stream";

import type { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import type { AcpTerminalProcess } from "./remoteWorkspaceAcpTerminal.ts";
import type {
  AcpTerminalCwdObservation,
  AcpTerminalCwdObserver,
} from "./remoteWorkspaceAcpTerminal.owner.proof.ts";
import { makeOwnedAcpTerminalProcess } from "./remoteWorkspaceAcpTerminal.owner.process.ts";
import {
  acpCommandText,
  isAcpPwdRequest,
  isAdmissibleAcpShellText,
} from "./remoteWorkspaceAcpTerminal.owner.command.ts";

export interface AcpApprovalIdentity {
  readonly requestId: ApprovalRequestId;
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
  readonly acpSessionId: string;
  readonly toolCallId: string;
}

export interface AcpOwnerCommand {
  readonly approval: AcpApprovalIdentity;
  readonly executionTargetId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  /** `pwd` is the fixed recipe; `shell-command` is the U21 ACP shell grant. */
  readonly operation: "print-working-directory" | "shell-command";
  /** U21: the exact approved command text (only for `shell-command`). */
  readonly command?: string;
  /** Absolute epoch milliseconds; a receipt is unusable at or after this instant.
   *  Production approval producers always set it; the proof helper may omit it. */
  readonly expiresAt?: number;
  /** Owner target generation in force when the user approved. */
  readonly generation?: string;
}

export type AcpOwnerExit =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signaled"; readonly signal: string };

export interface AcpOwnerCommandLease {
  /** Noninteractive: one backpressured stdout/stderr pipe, no stdin or PTY. */
  readonly output: Readable;
  /** Confirm exit for this command, not the shared SSH connection. Reject if unconfirmed. */
  readonly exit: Promise<AcpOwnerExit>;
  /** Terminate only this lease. Acknowledgement does not prove exit. */
  readonly cancel: () => Promise<void>;
}

export interface AcpTerminalSshOwner {
  /** Execute the fixed recipe on the exact target and cwd. Reject stale authority or a cwd
   * that resolves outside the workspace (including symlinks). Honor abort during acquisition
   * and reap any lease not returned. This port is not a native protocol implementation. */
  readonly runAcpCommand: (
    request: AcpOwnerCommand,
    acquisitionSignal: AbortSignal,
  ) => Promise<AcpOwnerCommandLease>;
  /** U21: run one approved ACP terminal command as its own owner grant. Optional:
   *  an owner without it refuses every command except the fixed `pwd` recipe. */
  readonly runAcpShell?: (
    request: AcpOwnerCommand,
    acquisitionSignal: AbortSignal,
  ) => Promise<AcpOwnerCommandLease>;
}

export class AcpTerminalOwnerError extends Error {
  constructor(
    readonly code:
      | "approval-required"
      | "approval-mismatch"
      | "unsupported-command"
      | "unsupported-target"
      | "unsupported-cwd"
      | "ssh-owner-unavailable",
  ) {
    super(`Selected SSH owner refused ACP terminal creation: ${code}.`);
    this.name = "AcpTerminalOwnerError";
  }
}

// Object identity is local to the trusted backend, not serializable ACP request metadata.
declare const approvalBrand: unique symbol;
export type AcpCommandApproval = { readonly [approvalBrand]: true };
const unusedApprovals = new WeakMap<AcpCommandApproval, AcpOwnerCommand>();

/** Only call from product code holding a correlated, explicit, one-time user decision.
 * The current ACP permission callback is not a producer: terminal/create has no tool-call or
 * approval ID, and an allow response to the agent is not an operand-bound receipt. */
export function issueAcpTerminalCommandApproval(
  command: AcpOwnerCommand & { readonly decision: "accept" },
): AcpCommandApproval {
  if (command.decision !== "accept") throw new AcpTerminalOwnerError("approval-required");
  const receipt = Object.freeze({}) as AcpCommandApproval;
  unusedApprovals.set(
    receipt,
    Object.freeze({
      approval: Object.freeze({
        requestId: command.approval.requestId,
        threadId: command.approval.threadId,
        sessionEpoch: command.approval.sessionEpoch,
        acpSessionId: command.approval.acpSessionId,
        toolCallId: command.approval.toolCallId,
      }),
      executionTargetId: command.executionTargetId,
      workspaceRoot: command.workspaceRoot,
      cwd: command.cwd,
      operation: command.operation,
      ...(command.command === undefined ? {} : { command: command.command }),
      expiresAt: command.expiresAt ?? Number.POSITIVE_INFINITY,
      generation: command.generation ?? "",
    }),
  );
  return receipt;
}

export interface SelectedAcpTerminalOwner {
  readonly kind: "selected";
  readonly owner?: AcpTerminalSshOwner;
  /** Trusted launch correlation, never copied from ACP metadata. */
  readonly identity?: AcpApprovalIdentity;
  readonly approval?: AcpCommandApproval;
  /** Current owner generation; omit only where no generation fence exists. */
  readonly generation?: string;
  /** Injectable clock for expiry; defaults to `Date.now`. */
  readonly now?: number;
  readonly signal: AbortSignal;
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    posix.isAbsolute(value) &&
    !value.includes("\0") &&
    (value === "/" || !value.endsWith("/")) &&
    posix.normalize(value) === value
  );
}

interface AcpOwnerInput {
  readonly executionTargetId: string;
  readonly workspaceRoot: string;
  readonly cwd?: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

type ApprovalSelection = Pick<
  SelectedAcpTerminalOwner,
  "identity" | "approval" | "signal" | "generation" | "now"
>;

function consumeAcpApproval(
  input: AcpOwnerInput,
  { identity, approval, signal, generation, now }: ApprovalSelection,
  allowShell = false,
): AcpOwnerCommand {
  signal.throwIfAborted();
  const target = parseSshExecutionTarget(input.executionTargetId);
  if (
    !target ||
    target.executionTargetId !== input.executionTargetId ||
    target.transport === "agent"
  ) {
    throw new AcpTerminalOwnerError("unsupported-target");
  }
  const pwd = isAcpPwdRequest(input);
  const commandText = pwd ? undefined : acpCommandText(input.command, input.args ?? []);
  if (
    !pwd &&
    (!allowShell || input.environment?.length || !isAdmissibleAcpShellText(commandText!))
  ) {
    throw new AcpTerminalOwnerError("unsupported-command");
  }
  const { workspaceRoot } = input;
  const cwd = input.cwd ?? workspaceRoot;
  if (
    !isCanonicalAbsolutePath(workspaceRoot) ||
    !isCanonicalAbsolutePath(cwd) ||
    (workspaceRoot !== "/" && cwd !== workspaceRoot && !cwd.startsWith(`${workspaceRoot}/`))
  ) {
    throw new AcpTerminalOwnerError("unsupported-cwd");
  }
  const approved = approval && unusedApprovals.get(approval);
  if (!approved || !approval || !identity) throw new AcpTerminalOwnerError("approval-required");
  if (
    approved.approval.requestId !== identity.requestId ||
    approved.approval.threadId !== identity.threadId ||
    approved.approval.sessionEpoch !== identity.sessionEpoch ||
    approved.approval.acpSessionId !== identity.acpSessionId ||
    approved.approval.toolCallId !== identity.toolCallId ||
    approved.executionTargetId !== input.executionTargetId ||
    approved.workspaceRoot !== workspaceRoot ||
    approved.cwd !== cwd ||
    approved.operation !== (pwd ? "print-working-directory" : "shell-command") ||
    approved.command !== commandText
  ) {
    throw new AcpTerminalOwnerError("approval-mismatch");
  }
  if (generation !== undefined && approved.generation !== generation) {
    throw new AcpTerminalOwnerError("approval-required");
  }
  if ((approved.expiresAt ?? Number.POSITIVE_INFINITY) <= (now ?? Date.now())) {
    throw new AcpTerminalOwnerError("approval-required");
  }
  // Consume synchronously before dispatch, even if acquisition fails. Never retry or fall back.
  unusedApprovals.delete(approval);
  return approved;
}

/** Explicit observation-only route; this cannot return an ACP process or an exit receipt. */
export async function observeOwnedAcpCwd(
  input: AcpOwnerInput,
  selection: ApprovalSelection & { readonly observer?: AcpTerminalCwdObserver },
): Promise<AcpTerminalCwdObservation> {
  const { observer, signal } = selection;
  signal.throwIfAborted();
  if (!observer) throw new AcpTerminalOwnerError("ssh-owner-unavailable");
  const approved = consumeAcpApproval(input, selection);
  const observation = await observer.observeAcpCwd(approved, signal);
  if (signal.aborted) {
    observation.output.destroy();
    signal.throwIfAborted();
  }
  return observation;
}

export async function createOwnedAcpTerminal(
  input: AcpOwnerInput,
  selection: SelectedAcpTerminalOwner,
): Promise<AcpTerminalProcess> {
  const { owner, signal } = selection;
  signal.throwIfAborted();
  if (!owner) throw new AcpTerminalOwnerError("ssh-owner-unavailable");
  const approved = consumeAcpApproval(input, selection, owner.runAcpShell !== undefined);
  const lease =
    approved.operation === "shell-command" && owner.runAcpShell
      ? await owner.runAcpShell(approved, signal)
      : await owner.runAcpCommand(approved, signal);
  const terminal = makeOwnedAcpTerminalProcess(lease, signal);
  if (signal.aborted) {
    await terminal.close();
    signal.throwIfAborted();
  }
  return terminal;
}
