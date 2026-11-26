import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  SHELL_PROVIDERS,
  validCommand,
  validIdentity,
  validTimeout,
} from "./sshOwnerPickerProof.codec.shell.ts";
import {
  boolValue,
  bytesValue,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * W2 T-shell production exec leases (Request 90–94, Reply 56). Each open is its
 * own grant-bound role; status and close name the role. The owner selects the
 * program, shell, transport and deadline; the request carries no stdin, PTY,
 * environment, argv or SSH option.
 *
 * @module sshOwnerPickerProof.codec.shellLease
 */
export type ShellLeaseRole = "thread" | "providerWorkspace" | "acp" | "acpShell";

const ROLE_FIELD = { thread: 1, providerWorkspace: 2, acp: 3, acpShell: 4 } as const;
const ROLES = { 1: "thread", 2: "providerWorkspace", 3: "acp", 4: "acpShell" } as const;
const MAX_PATH_BYTES = 4096;
/** The owner retains at most 8 MiB of combined output per lease. */
export const SHELL_LEASE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;

export type ShellLeaseOperation =
  | {
      readonly kind: "runThreadShell";
      readonly lease: Uint8Array;
      readonly workspaceRoot: string;
      readonly cwd: string;
      readonly threadId: string;
      readonly command: string;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "runProviderWorkspaceShell";
      readonly lease: Uint8Array;
      readonly workspaceRoot: string;
      readonly cwd: string;
      readonly provider: string;
      readonly sessionId: string;
      readonly invocationId: string;
      readonly command: string;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "runAcpCommand";
      readonly lease: Uint8Array;
      readonly workspaceRoot: string;
      readonly cwd: string;
    }
  | {
      /** U21: an approved ACP terminal/create command (Request 95). */
      readonly kind: "runAcpShell";
      readonly lease: Uint8Array;
      readonly workspaceRoot: string;
      readonly cwd: string;
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly command: string;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "shellStatus";
      readonly lease: Uint8Array;
      readonly role: ShellLeaseRole;
      readonly offset: number;
    }
  | { readonly kind: "shellClose"; readonly lease: Uint8Array; readonly role: ShellLeaseRole };

export type ShellLeaseState = { readonly lease: Uint8Array; readonly role: ShellLeaseRole } & (
  | { readonly phase: "running" | "closed" }
  | {
      readonly phase: "exited";
      readonly output: Uint8Array;
      readonly outputSize: number;
      readonly exitCode: number;
      readonly truncated: boolean;
    }
);

function exactPath(path: string): boolean {
  if (!path.startsWith("/") || Buffer.byteLength(path) > MAX_PATH_BYTES) return false;
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  return !path
    .slice(1)
    .split("/")
    .some((part) => part === "" || part === "." || part === "..");
}

/** Mirrors the owner: an exact root (not `/`) and a cwd equal to or under it. */
export function shellLeaseAdmits(workspaceRoot: string, cwd: string): boolean {
  return (
    exactPath(workspaceRoot) &&
    exactPath(cwd) &&
    (cwd === workspaceRoot || cwd.startsWith(`${workspaceRoot}/`))
  );
}

const refuse = () => new PickerProofOwnerError("invalidOperands");

export function writeShellLease(writer: WireWriter, operation: ShellLeaseOperation) {
  if (operation.lease.length !== PROOF_TOKEN_BYTES) throw refuse();
  const operands = new WireWriter();
  operands.fieldBytes(1, operation.lease);
  if (operation.kind === "shellStatus" || operation.kind === "shellClose") {
    operands.fieldUint(2, ROLE_FIELD[operation.role]);
    if (operation.kind === "shellStatus") {
      if (!Number.isSafeInteger(operation.offset) || operation.offset < 0) throw refuse();
      operands.fieldUint(3, operation.offset);
    }
    writer.fieldRepeatedMessage(operation.kind === "shellStatus" ? 93 : 94, operands.finish());
    return;
  }
  if (!shellLeaseAdmits(operation.workspaceRoot, operation.cwd)) throw refuse();
  operands.fieldString(2, operation.workspaceRoot);
  operands.fieldString(3, operation.cwd);
  if (operation.kind === "runAcpCommand") {
    writer.fieldRepeatedMessage(92, operands.finish());
    return;
  }
  if (!validCommand(operation.command) || !validTimeout(operation.timeoutMs)) throw refuse();
  if (operation.kind === "runAcpShell") {
    if (!validIdentity(operation.sessionId) || !validIdentity(operation.toolCallId)) throw refuse();
    operands.fieldString(4, operation.sessionId);
    operands.fieldString(5, operation.toolCallId);
    operands.fieldString(6, operation.command);
    operands.fieldUint(7, operation.timeoutMs);
    writer.fieldRepeatedMessage(95, operands.finish());
    return;
  }
  if (operation.kind === "runThreadShell") {
    if (!validIdentity(operation.threadId)) throw refuse();
    operands.fieldString(4, operation.threadId);
    operands.fieldString(5, operation.command);
    operands.fieldUint(6, operation.timeoutMs);
    writer.fieldRepeatedMessage(90, operands.finish());
    return;
  }
  if (
    !SHELL_PROVIDERS.includes(operation.provider as (typeof SHELL_PROVIDERS)[number]) ||
    !validIdentity(operation.sessionId) ||
    !validIdentity(operation.invocationId)
  )
    throw refuse();
  operands.fieldString(4, operation.provider);
  operands.fieldString(5, operation.sessionId);
  operands.fieldString(6, operation.invocationId);
  operands.fieldString(7, operation.command);
  operands.fieldUint(8, operation.timeoutMs);
  writer.fieldRepeatedMessage(91, operands.finish());
}

export function readShellLease(bytes: Uint8Array): ShellLeaseState {
  let lease: Uint8Array | undefined;
  let role: number | undefined;
  let phase: number | undefined;
  let output: Uint8Array | undefined;
  let outputSize: number | undefined;
  let exitCode: number | undefined;
  let truncated: boolean | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && lease === undefined) lease = bytesValue(wire, reader);
    else if (field === 2 && role === undefined) role = uintValue(wire, reader);
    else if (field === 3 && phase === undefined) phase = uintValue(wire, reader);
    else if (field === 4 && output === undefined) output = bytesValue(wire, reader);
    else if (field === 5 && outputSize === undefined) outputSize = uintValue(wire, reader);
    else if (field === 6 && exitCode === undefined) exitCode = uintValue(wire, reader);
    else if (field === 7 && truncated === undefined) truncated = boolValue(wire, reader);
    else return invalid();
  });
  const named = role === undefined ? undefined : ROLES[role as keyof typeof ROLES];
  if (lease?.length !== PROOF_TOKEN_BYTES || !named) return invalid();
  if (phase === 2) {
    const size = outputSize ?? 0;
    const chunk = output ?? new Uint8Array();
    if (
      exitCode === undefined ||
      exitCode > 255 ||
      size > SHELL_LEASE_MAX_OUTPUT_BYTES ||
      chunk.length > Math.min(MAX_CHUNK_BYTES, size)
    )
      return invalid();
    return {
      lease,
      role: named,
      phase: "exited",
      output: chunk,
      outputSize: size,
      exitCode,
      truncated: truncated ?? false,
    };
  }
  if (output !== undefined || outputSize !== undefined || exitCode !== undefined || truncated)
    return invalid();
  if (phase === 1) return { lease, role: named, phase: "running" };
  if (phase === 3) return { lease, role: named, phase: "closed" };
  return invalid();
}
