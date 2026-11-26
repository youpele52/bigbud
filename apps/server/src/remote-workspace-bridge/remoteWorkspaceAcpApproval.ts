import { posix } from "node:path";
import { randomUUID } from "node:crypto";

import type { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";

import {
  AcpTerminalOwnerError,
  issueAcpTerminalCommandApproval,
  type AcpApprovalIdentity,
  type AcpCommandApproval,
  type AcpOwnerCommand,
} from "./remoteWorkspaceAcpTerminal.owner.ts";
import { isAdmissibleAcpShellText } from "./remoteWorkspaceAcpTerminal.owner.command.ts";

export const ACP_APPROVAL_TTL_MS = 60_000;

export interface AcpTerminalApprovalRequest {
  /** Trusted launch correlation supplied by the backend, never copied from ACP metadata. */
  readonly requestId: ApprovalRequestId;
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
  readonly acpSessionId: string;
  readonly cwd: string;
  /** U21: the exact command text for the ACP shell grant; absent for the fixed `pwd`. */
  readonly command?: string;
}

export interface AcpTerminalApprovalProducer {
  /**
   * Bind one explicit user decision to the workspace, cwd and the fixed `pwd`
   * recipe. The returned receipt is single-use and expires with the generation.
   */
  issue(request: AcpTerminalApprovalRequest): {
    readonly approval: AcpCommandApproval;
    readonly identity: AcpApprovalIdentity;
  };
  /** The owner generation in force; a rotation invalidates every unused receipt. */
  readonly generation: () => string;
}

function canonicalAbsolute(value: string): boolean {
  return (
    posix.isAbsolute(value) &&
    !value.includes("\0") &&
    (value === "/" || !value.endsWith("/")) &&
    posix.normalize(value) === value
  );
}

/**
 * Production approval producer for direct ACP commands. Only a composed producer
 * lets the bridge advertise the terminal capability; otherwise every
 * terminal/create remains the typed refusal.
 */
export function makeAcpTerminalApprovalProducer(options: {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly generation: () => string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}): AcpTerminalApprovalProducer {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ACP_APPROVAL_TTL_MS;
  if (!canonicalAbsolute(options.workspaceRoot) || options.workspaceRoot === "/") {
    throw new AcpTerminalOwnerError("unsupported-cwd");
  }
  return {
    generation: options.generation,
    issue(request) {
      if (
        !request.acpSessionId ||
        request.acpSessionId.length > 256 ||
        !Number.isSafeInteger(request.sessionEpoch) ||
        request.sessionEpoch < 0 ||
        !canonicalAbsolute(request.cwd) ||
        (request.cwd !== options.workspaceRoot &&
          !request.cwd.startsWith(`${options.workspaceRoot}/`))
      ) {
        throw new AcpTerminalOwnerError("unsupported-cwd");
      }
      if (request.command !== undefined && !isAdmissibleAcpShellText(request.command)) {
        throw new AcpTerminalOwnerError("unsupported-command");
      }
      const identity: AcpApprovalIdentity = {
        requestId: request.requestId,
        threadId: request.threadId,
        sessionEpoch: request.sessionEpoch,
        acpSessionId: request.acpSessionId,
        toolCallId: randomUUID(),
      };
      const command: AcpOwnerCommand = {
        approval: identity,
        executionTargetId: options.targetId,
        workspaceRoot: options.workspaceRoot,
        cwd: request.cwd,
        ...(request.command === undefined
          ? { operation: "print-working-directory" as const }
          : { operation: "shell-command" as const, command: request.command }),
        expiresAt: now() + ttlMs,
        generation: options.generation(),
      };
      return {
        approval: issueAcpTerminalCommandApproval({ ...command, decision: "accept" }),
        identity,
      };
    },
  };
}
